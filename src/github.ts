/**
 * The scan: two searches against the GitHub GraphQL API, unioned.
 *
 * Two failure shapes are handled explicitly, both observed live (ticket 0001):
 * an over-budget query returns an **HTML** 502 that will not parse as JSON, and
 * a partially-resolved query returns HTTP 200 carrying `data` alongside a
 * per-field `errors[]` array.
 */

import { normalize, sanitize, type PullRequest, type RawPullRequest } from "./domain";
import { buildSearchQuery, SCAN_FILTERS, SCAN_QUERY, type ScanFilter } from "./query";

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

async function post(
  token: string,
  variables: { q: string; first: number; after: string | null },
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "prq",
    },
    body: JSON.stringify({ query: SCAN_QUERY, variables }),
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

  let parsed: { data?: SearchResponse; errors?: Array<{ message?: string; type?: string }> };
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
    const data: SearchResponse = await post(token, { q, first: PAGE_SIZE, after }, signal);
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
