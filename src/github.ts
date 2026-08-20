/**
 * The scan: two searches against the GitHub GraphQL API, unioned.
 *
 * Two failure shapes are handled explicitly, both observed live (ticket 0001):
 * an over-budget query returns an **HTML** 502 that will not parse as JSON, and
 * a partially-resolved query returns HTTP 200 carrying `data` alongside a
 * per-field `errors[]` array.
 */

import {
  canonicalTime,
  normalize,
  safeUrl,
  sanitize,
  type PullRequest,
  type RawPullRequest,
} from "./domain";
import {
  MAX_PAGES as CENSUS_MAX_PAGES,
  PAGE_SIZE as CENSUS_PAGE_SIZE,
  toCount,
  toLogin,
  toPrState,
  toReviewAct,
  toTime,
  type CensusClient,
  type CensusPr,
  type CensusReview,
  type RepoCensus,
} from "./census";
import {
  buildSearchQuery,
  CENSUS_QUERY,
  isValidRepo,
  SCAN_FILTERS,
  SCAN_QUERY,
  splitRepo,
  type ScanFilter,
} from "./query";
import type { ProviderClient, ProviderScan } from "./providers";

const ENDPOINT = "https://api.github.com/graphql";
const PAGE_SIZE = 100;
/** Guards against an unexpectedly huge result set; the filters keep us far below. */
const MAX_PAGES = 10;

export interface ScanResult {
  viewer: string;
  prs: PullRequest[];
  /** Non-empty when one of the two queries failed — the union is incomplete. */
  failures: string[];
  cost: number;
  remaining: number;
}

interface SearchResponse {
  rateLimit: { cost: number; remaining: number } | null;
  viewer: { login: string };
  search: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<RawPullRequest | Record<string, never>>;
  };
}

export class GitHubError extends Error {}

export async function githubToken(): Promise<string> {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;

  const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
  // stderr must be drained, not just piped: an unread pipe can block `exited`
  // once its buffer fills. It also carries the only useful diagnosis when the
  // token is expired, the keyring is locked, or GH_HOST is misconfigured.
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const token = out.trim();
  if (code !== 0 || !token) {
    const detail = err.trim();
    throw new GitHubError(
      `no GitHub token — run \`gh auth login\`, or set GITHUB_TOKEN${detail ? `\n  gh: ${detail}` : ""}`,
    );
  }
  return token;
}

/**
 * The one HTTP path to GitHub. Both the scan and the census go through it, so
 * the two failure shapes below are handled in exactly one place.
 */
async function post<T>(
  token: string,
  query: string,
  variables: Record<string, string | number | null>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "prq",
    },
    body: JSON.stringify({ query, variables }),
    signal,
  });

  const body = await response.text();

  if (!response.ok) {
    // 502 arrives as an HTML error page, so report the status rather than
    // trying to parse it.
    throw new GitHubError(
      response.status === 502 || response.status === 504
        ? `GitHub returned ${response.status} — the query exceeded its execution budget`
        : `GitHub returned ${response.status}`,
    );
  }

  let parsed: { data?: T; errors?: Array<{ message?: string; type?: string }> };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new GitHubError("GitHub returned a non-JSON body");
  }

  // HTTP 200 with a partial payload: surface it rather than rendering holes.
  if (parsed.errors?.length) {
    const first = parsed.errors[0];
    throw new GitHubError(
      `GitHub reported ${parsed.errors.length} error(s): ${first?.type ?? first?.message ?? "unknown"}`,
    );
  }
  if (!parsed.data) throw new GitHubError("GitHub returned no data");
  return parsed.data;
}

interface FilterResult {
  viewer: string;
  raw: RawPullRequest[];
  cost: number;
  remaining: number;
  /** Set when the connection had more results than we were willing to fetch. */
  truncated: { fetched: number; total: number } | null;
}

async function runFilter(
  token: string,
  repos: string[],
  filter: ScanFilter,
  signal?: AbortSignal,
): Promise<FilterResult> {
  const q = buildSearchQuery(repos, filter);
  const raw: RawPullRequest[] = [];
  let after: string | null = null;
  let viewer = "";
  let cost = 0;
  let remaining = Number.POSITIVE_INFINITY;
  let total = 0;
  let truncated: FilterResult["truncated"] = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    // Annotated, not inferred. `after` is reassigned from this very response, so
    // the object literal's contextual type makes the compiler chase `data` ->
    // `endCursor` -> `after` -> `data` and give up with an implicit `any`
    // (TS7022). The annotation cuts the cycle; a declared type on `after` does
    // not, because the literal is typed from its narrowed type.
    const data: SearchResponse = await post<SearchResponse>(
      token,
      SCAN_QUERY,
      { q, first: PAGE_SIZE, after },
      signal,
    );
    viewer = data.viewer.login;
    total = data.search.issueCount;
    cost += data.rateLimit?.cost ?? 0;
    remaining = Math.min(remaining, data.rateLimit?.remaining ?? Number.POSITIVE_INFINITY);
    // Search returns a union; non-PR nodes come back as empty objects.
    raw.push(...data.search.nodes.filter((n): n is RawPullRequest => "id" in n));

    const { hasNextPage, endCursor } = data.search.pageInfo;
    // A null cursor with hasNextPage set would send `after` back to null and
    // re-fetch page one forever. Treat a missing cursor as the end.
    if (!hasNextPage || !endCursor) break;
    after = endCursor;

    if (page === MAX_PAGES - 1) {
      // Stopping here is a truncation, and it must be reported: otherwise a
      // clipped union is cached as a complete scan for the whole TTL.
      truncated = { fetched: raw.length, total };
    }
  }

  return { viewer, raw, cost, remaining, truncated };
}

/**
 * Runs both halves in parallel and unions them by node id. A PR matching both
 * filters — one you authored and were then asked to review — appears once.
 */
export async function scan(
  repos: string[],
  token: string,
  signal?: AbortSignal,
): Promise<ScanResult> {
  const settled = await Promise.allSettled(
    SCAN_FILTERS.map((filter) => runFilter(token, repos, filter, signal)),
  );

  const failures: string[] = [];
  const rejections: string[] = [];
  const byId = new Map<string, RawPullRequest>();
  let viewer = "";
  let cost = 0;
  let remaining = Number.POSITIVE_INFINITY;

  settled.forEach((outcome, index) => {
    if (outcome.status === "rejected") {
      // GraphQL error text is server-supplied and reaches the terminal, so it
      // is sanitised like any other remote string.
      const message = sanitize(
        `${SCAN_FILTERS[index]}: ${outcome.reason?.message ?? outcome.reason}`,
      );
      rejections.push(message);
      failures.push(message);
      return;
    }
    viewer = outcome.value.viewer || viewer;
    cost += outcome.value.cost;
    // The budget is the smallest of the two, not the last one seen — and `||`
    // would discard a legitimate zero, the value that matters most.
    remaining = Math.min(remaining, outcome.value.remaining);
    if (outcome.value.truncated) {
      const { fetched, total } = outcome.value.truncated;
      failures.push(
        `${SCAN_FILTERS[index]}: truncated at ${fetched} of ${total} results`,
      );
    }
    for (const pr of outcome.value.raw) byId.set(pr.id, pr);
  });

  // Only a total rejection is fatal. Truncation is a failure to report, not a
  // reason to discard the results we do have.
  if (rejections.length === SCAN_FILTERS.length) {
    throw new GitHubError(rejections.join("; "));
  }

  return {
    viewer,
    prs: [...byId.values()].map((pr) => normalize(pr, viewer)),
    failures,
    cost,
    remaining: Number.isFinite(remaining) ? remaining : 0,
  };
}

/** The GitHub half of the provider seam. `scan` above stays the implementation. */
export const github: ProviderClient = {
  provider: "github",
  token: githubToken,
  async scan(projects, token, signal): Promise<ProviderScan> {
    if (projects.length === 0) return { rows: [], failed: [], viewer: "" };
    const result = await scan(projects, token, signal);
    return { rows: result.prs, failed: result.failures, viewer: result.viewer };
  },
};

/**
 * The census: one repository walked whole, every state, newest first.
 *
 * Shapes worth knowing before reading the walk. `repository` comes back **null**
 * for a repo that was renamed, made private or deleted, and it arrives as a
 * clean HTTP 200 — indistinguishable from success unless it is checked. And a
 * census failure must not be fatal: the caller is walking a configured list, so
 * one unreadable repo is a `failed` row, not an aborted run.
 */
interface RawCensusReview {
  state?: string | null;
  submittedAt?: string | null;
  author?: { login?: string | null } | null;
}

interface RawCensusPr {
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  isDraft?: boolean;
  createdAt?: string;
  updatedAt?: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  author?: { login?: string | null } | null;
  mergedBy?: { login?: string | null } | null;
  reviews?: { nodes?: Array<RawCensusReview | null> | null } | null;
}

interface CensusResponse {
  rateLimit: { cost: number; remaining: number } | null;
  repository: {
    pullRequests: {
      totalCount: number;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes?: Array<RawCensusPr | null> | null;
    };
  } | null;
}

function toCensusPr(repo: string, node: RawCensusPr): CensusPr {
  const state = toPrState(node.state);
  return {
    provider: "github",
    repo,
    number: toCount(node.number),
    state,
    draft: node.isDraft === true,
    title: typeof node.title === "string" ? sanitize(node.title) : "",
    url: safeUrl(node.url),
    author: toLogin(node.author?.login),
    createdAt: toTime(node.createdAt) ?? "",
    updatedAt: toTime(node.updatedAt) ?? "",
    mergedAt: toTime(node.mergedAt),
    closedAt: toTime(node.closedAt),
    additions: toCount(node.additions),
    deletions: toCount(node.deletions),
    files: toCount(node.changedFiles),
    // The contract is "empty unless merged", so the field is read only when the
    // state agrees — a merger on a non-merged row would misreport who shipped it.
    mergedBy: state === "merged" ? toLogin(node.mergedBy?.login) : "",
  };
}

function collectReviews(repo: string, number: number, node: RawCensusPr): CensusReview[] {
  const out: CensusReview[] = [];
  for (const review of node.reviews?.nodes ?? []) {
    if (!review) continue;
    const act = toReviewAct(review.state);
    // PENDING is an unsubmitted draft review, visible only to its author. It is
    // not an act, and counting it would credit a review nobody ever received.
    if (act === null) continue;
    out.push({
      provider: "github",
      repo,
      number,
      reviewer: toLogin(review.author?.login),
      act,
      // Real on GitHub, which is why `reviewPrecision` is exact here.
      at: toTime(review.submittedAt),
    });
  }
  return out;
}

/**
 * A refusal, which is a contract and not merely an early return: no rows, no
 * reviews, `truncated` false, and a message that has crossed the trust boundary
 * — server error text ends up in the terminal like any other remote string.
 */
function refused(repo: string, failed: string): RepoCensus {
  return {
    provider: "github",
    repo,
    prs: [],
    reviews: [],
    reviewPrecision: "exact",
    failed: sanitize(failed),
    truncated: false,
  };
}

/**
 * Walks one repository. `since` is a watermark, not a filter: pages arrive
 * newest-updated first, so the first row that predates it ends the walk and is
 * itself dropped — the caller already holds it and everything behind it.
 *
 * Rows are discarded on failure rather than returned as a partial census. A
 * prefix that looks whole is the one outcome that would poison the store, since
 * `writeCensus` replaces a repo's history wholesale.
 */
export async function readRepoCensus(
  repo: string,
  token: string,
  since: string | null,
  signal?: AbortSignal,
): Promise<RepoCensus> {
  const prs: CensusPr[] = [];
  const reviews: CensusReview[] = [];
  let truncated = false;

  try {
    const { owner, name } = splitRepo(repo);
    // Canonicalised for the same reason `canonicalTime` exists: the comparison
    // below is a string comparison, and an offset-bearing watermark would sort
    // by its digits rather than its instant.
    const floor = since === null ? null : canonicalTime(since);
    let after: string | null = null;

    for (let page = 0; page < CENSUS_MAX_PAGES; page++) {
      // Checked between pages, not only inside `fetch`: the largest repo is 34
      // requests, and a Ctrl-C must not wait for the rest of them.
      signal?.throwIfAborted();

      // Annotated for the same reason as the scan walk above: `after` closes a
      // reference cycle the compiler will not resolve on its own.
      const data: CensusResponse = await post<CensusResponse>(
        token,
        CENSUS_QUERY,
        { owner, name, first: CENSUS_PAGE_SIZE, after },
        signal,
      );
      const connection = data.repository?.pullRequests;
      if (!connection) {
        throw new GitHubError(
          `GitHub returned no repository — ${repo} is private, renamed or gone`,
        );
      }

      let reachedFloor = false;
      for (const node of connection.nodes ?? []) {
        if (!node) continue;
        const pr = toCensusPr(repo, node);
        if (floor !== null && pr.updatedAt < floor) {
          reachedFloor = true;
          break;
        }
        prs.push(pr);
        reviews.push(...collectReviews(repo, pr.number, node));
      }
      if (reachedFloor) break;

      const { hasNextPage, endCursor } = connection.pageInfo;
      // A null cursor with hasNextPage set would send `after` back to null and
      // re-fetch page one forever. Treat a missing cursor as the end.
      if (!hasNextPage || !endCursor) break;
      if (page === CENSUS_MAX_PAGES - 1) {
        // Say so rather than returning a prefix dressed as a whole history.
        truncated = true;
        break;
      }
      after = endCursor;
    }
  } catch (error) {
    return refused(repo, error instanceof Error ? error.message : String(error));
  }

  return {
    provider: "github",
    repo,
    prs,
    reviews,
    reviewPrecision: "exact",
    failed: null,
    truncated,
  };
}

/** The GitHub half of the census seam. */
export const githubCensus: CensusClient = {
  async censusRepo(repo, since, signal): Promise<RepoCensus> {
    // Before the token, deliberately: an unvalidated repo reaches a query, and
    // there is no sense spawning `gh auth token` for a name we will refuse.
    if (!isValidRepo(repo)) return refused(repo, `not owner/name: ${JSON.stringify(repo)}`);
    return readRepoCensus(repo, await githubToken(), since, signal);
  },
};
