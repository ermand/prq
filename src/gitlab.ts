/**
 * The GitLab provider.
 *
 * One GraphQL query — `projects(fullPaths: [...])` — because it is the only call
 * in either GitLab API that scopes to an arbitrary list of projects in a single
 * request, and its complexity does not grow with the number of paths. Measured
 * 1 request and ~0.9s against 18 requests and 11.6s for the REST equivalent.
 *
 * Then a **client-side involvement filter**, because `involves:@me` has no GitLab
 * equivalent and provably cannot have one: mentions and commenter are unfilterable
 * in both APIs. `commenters` and `participants` exist as fields though not as
 * filters, so the GitLab scan inverts GitHub's into fetch-then-filter.
 *
 * How GitLab's states map onto the taxonomy is wayfinder ticket 0021, still open —
 * the mappings here are prototype-grade and flagged where they are lossy.
 *
 * `gitlabCensus` is the other axis: every merge request in one project, whatever
 * its state and whoever opened it. It shares this module's transport and token
 * path on purpose — a census is several pages of requests, so it is *more*
 * exposed to a lapsing OAuth token than a scan is, not less.
 */

import {
  canonicalTime,
  OID,
  sanitize,
  safeUrl,
  type Checks,
  type MergeState,
  type PullRequest,
  type StackMembership,
  type StaleBlock,
  type Standing,
  type Verdict,
} from "./domain";
import {
  MAX_PAGES,
  PAGE_SIZE as CENSUS_PAGE,
  toCount,
  toLogin,
  toPrState,
  toReviewAct,
  toTime,
  type CensusClient,
  type CensusPr,
  type CensusReview,
  type RepoCensus,
  type ReviewAct,
} from "./census";
import type { ProviderClient, ProviderScan } from "./providers";

const ENDPOINT = "https://gitlab.com/api/graphql";
/** GraphQL complexity ceiling is 250; a rich selection passes at 50 and fails at 60. */
const PAGE_SIZE = 50;

interface UserRef {
  username: string;
}

interface Interaction {
  reviewState: string | null;
  reviewed: boolean | null;
  approved: boolean | null;
  updatedAt: string | null;
}

interface RawMergeRequest {
  id: string;
  iid: string;
  title: string;
  webUrl: string | null;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  diffHeadSha: string | null;
  targetBranch: string;
  conflicts: boolean | null;
  mergeStatusEnum: string | null;
  detailedMergeStatus: string | null;
  approvalsRequired: number | null;
  author: UserRef | null;
  project: { fullPath: string } | null;
  headPipeline: { status: string } | null;
  approvedBy: { nodes: UserRef[] } | null;
  /** Null on projects without the paid feature — which doubles as a capability probe. */
  changeRequesters: { nodes: UserRef[] } | null;
  reviewers: {
    nodes: Array<UserRef & { mergeRequestInteraction: Interaction | null }>;
  } | null;
  assignees: { nodes: UserRef[] } | null;
  commenters: { nodes: UserRef[] } | null;
  participants: { nodes: UserRef[] } | null;
  /** A path, not a partition — includes self, open layers only. */
  stack: Array<{ id: string; iid: string }> | null;
  mergeRequestDiffs: { nodes: Array<{ createdAt: string }> } | null;
}

const MR_FIELDS = `
  id iid title webUrl draft createdAt updatedAt diffHeadSha targetBranch
  conflicts mergeStatusEnum detailedMergeStatus approvalsRequired
  author { username }
  project { fullPath }
  headPipeline { status }
  approvedBy { nodes { username } }
  changeRequesters { nodes { username } }
  reviewers { nodes { username mergeRequestInteraction { reviewState reviewed approved updatedAt } } }
  assignees { nodes { username } }
  commenters { nodes { username } }
  participants { nodes { username } }
  stack { id iid }
  mergeRequestDiffs(first: 1) { nodes { createdAt } }
`;

const SCAN_QUERY = `
query Scan($paths: [String!], $first: Int!) {
  currentUser { username }
  projects(fullPaths: $paths) {
    nodes {
      fullPath
      mergeRequests(state: opened, first: $first) {
        count
        pageInfo { hasNextPage }
        nodes { ${MR_FIELDS} }
      }
    }
  }
}`;

export class GitLabError extends Error {}

export function toChecksFromPipeline(status: string | null | undefined): Checks {
  switch (status) {
    case "SUCCESS":
      return "success";
    case "FAILED":
      return "failing";
    case "CREATED":
    case "WAITING_FOR_RESOURCE":
    case "WAITING_FOR_CALLBACK":
    case "PREPARING":
    case "PENDING":
    case "RUNNING":
    case "SCHEDULED":
      return "pending";
    // CANCELED, CANCELING, SKIPPED and MANUAL are not failures and not progress —
    // nothing is going to happen, which is what `none` already means.
    default:
      return "none";
  }
}

/** Usernames from a connection GitLab may hand back as null. */
function names(connection: { nodes: UserRef[] } | null | undefined): string[] {
  return (connection?.nodes ?? []).map((u) => u.username);
}

export function toMergeStateFromStatus(
  mergeStatus: string | null | undefined,
  conflicts: boolean | null | undefined,
  detailed: string | null | undefined,
): MergeState {
  // `conflicts` is documented as derived from merge_status and was caught live
  // reporting false while detailedMergeStatus said CONFLICT, so the detailed
  // status wins where they disagree. NEED_REBASE is a conflict by another name.
  if (detailed === "CONFLICT" || detailed === "NEED_REBASE" || conflicts === true) {
    return "conflicted";
  }
  // Not yet computed. RECHECK means "invalidated, awaiting recomputation" — call
  // it clean and GitLab's invalidation reads as "your conflict was resolved",
  // firing a spurious merge change each way. Measured at 38% incidence on the
  // driver's own MRs.
  if (
    mergeStatus === "UNCHECKED" ||
    mergeStatus === "CHECKING" ||
    mergeStatus === "CANNOT_BE_MERGED_RECHECK"
  ) {
    return "unknown";
  }
  if (
    detailed === "PREPARING" ||
    detailed === "CHECKING" ||
    detailed === "UNCHECKED" ||
    detailed === "APPROVALS_SYNCING"
  ) {
    return "unknown";
  }
  if (mergeStatus === "CAN_BE_MERGED") return "clean";
  // `CANNOT_BE_MERGED` is the last signal standing when `conflicts` lies, so it is
  // trusted — but only when nothing more specific is available. Any *named*
  // detailed status that reaches this line is a non-conflict blocker (CONFLICT and
  // NEED_REBASE were caught at the top), and those already have columns:
  // CI_MUST_PASS is the checks glyph, NOT_APPROVED the verdict, DRAFT_STATUS the
  // draft marker. Calling them content conflicts would double-report the same fact
  // under the wrong name. The two axes are genuinely independent — live data has
  // CAN_BE_MERGED alongside both CI_MUST_PASS and CI_STILL_RUNNING.
  if (mergeStatus === "CANNOT_BE_MERGED") {
    return detailed ? "clean" : "conflicted";
  }
  return "unknown";
}

/** A reviewer state that means the review is settled rather than outstanding. */
const SETTLED_REVIEW = new Set(["APPROVED", "REQUESTED_CHANGES", "REVIEWED"]);

/** Anyone on the reviewer list whose latest state blocks the merge request. */
function blockingReviewers(mr: RawMergeRequest): string[] {
  return (mr.reviewers?.nodes ?? [])
    .filter((r) => r.mergeRequestInteraction?.reviewState === "REQUESTED_CHANGES")
    .map((r) => r.username);
}

export function verdictOf(mr: RawMergeRequest): Verdict {
  // `changeRequesters === null` means the project cannot report a blocking review
  // at all — the free-tier capability probe. It is not "nobody blocked", so the
  // reviewer states are consulted too: otherwise a free-tier row shows an OPEN
  // badge while sitting in "I blocked it, and it moved".
  const blockers =
    mr.changeRequesters === null ? blockingReviewers(mr) : names(mr.changeRequesters);
  if (blockers.length > 0 || mr.detailedMergeStatus === "REQUESTED_CHANGES") {
    return "changes-requested";
  }
  if (names(mr.approvedBy).length > 0) return "approved";
  // `approved` is deliberately not used: it means "satisfies the required count",
  // and REST and GraphQL were observed disagreeing on it for the same MR.
  return (mr.approvalsRequired ?? 0) > 0 ? "awaiting-review" : "review-optional";
}

export function standingOf(mr: RawMergeRequest, viewer: string): Standing {
  if (mr.author?.username === viewer) return "mine";

  const mine = mr.reviewers?.nodes.find((r) => r.username === viewer);
  const state = mine?.mergeRequestInteraction?.reviewState;

  // Presence on GitLab's reviewer list *is* the review request, so anything not
  // positively settled is still outstanding — including `UNAPPROVED`, where the
  // reviewer withdrew their approval, and a null interaction, where nothing is
  // known. Testing for the settled states rather than the unsettled ones means a
  // state GitLab adds later defaults to "still on me" instead of silently
  // emptying bucket 1. GitHub's analogue gives a live request the same
  // unconditional precedence.
  if (mine && !SETTLED_REVIEW.has(state ?? "")) return "awaiting-me";

  if (state === "REQUESTED_CHANGES" || names(mr.changeRequesters).includes(viewer)) {
    return "i-requested-changes";
  }
  if (state === "APPROVED" || names(mr.approvedBy).includes(viewer)) return "i-approved";
  // `REVIEWED` is "marked as reviewed" with no opinion — the closest thing GitLab
  // has to a comment-only review, and the most common state observed.
  if (state === "REVIEWED" || names(mr.commenters).includes(viewer)) return "i-commented";
  return "not-involved";
}

/**
 * GitLab records no commit against a review state, so the sha comparison GitHub
 * uses cannot be ported. The closest primitive is time: my review is stale if it
 * predates the newest diff version. `null` when the review carries no timestamp —
 * 20% of the blocking cohort when measured.
 */
export function staleBlockOf(mr: RawMergeRequest, viewer: string): StaleBlock | null {
  const blocking =
    mr.reviewers?.nodes.find((r) => r.username === viewer)?.mergeRequestInteraction
      ?.reviewState === "REQUESTED_CHANGES" || names(mr.changeRequesters).includes(viewer);
  if (!blocking) return null;

  const reviewedAt = mr.reviewers?.nodes.find((r) => r.username === viewer)
    ?.mergeRequestInteraction?.updatedAt;
  const latestDiff = mr.mergeRequestDiffs?.nodes[0]?.createdAt;
  if (!reviewedAt || !latestDiff) return null;

  return {
    value: canonicalTime(reviewedAt) < canonicalTime(latestDiff),
    precision: "approximate",
  };
}

/**
 * GitLab's `stack` includes the MR itself and is ordered, so position is its index
 * within it. There is no stack identity, so the **bottom member's id** stands in:
 * every member of one chain agrees on it. Chains can overlap — one MR may appear
 * in several — so two rows may legitimately disagree about which chain they are
 * in, and focusing a row shows that row's chain. It lists only open layers, so a
 * partly-landed stack cannot report `5/6`: hence `approximate`.
 */
export function stacksOf(mr: RawMergeRequest): StackMembership[] {
  const chain = mr.stack ?? [];
  if (chain.length === 0) return [];
  const index = chain.findIndex((m) => m.id === mr.id);
  if (index === -1) return [];
  return [
    {
      id: chain[0]!.id,
      size: chain.length,
      position: index + 1,
      precision: "approximate",
    },
  ];
}

/** Author, assignee, reviewer, commenter or participant. The `involves:` stand-in. */
export function concernsViewer(mr: RawMergeRequest, viewer: string): boolean {
  if (mr.author?.username === viewer) return true;
  if (names(mr.assignees).includes(viewer)) return true;
  if (mr.reviewers?.nodes.some((r) => r.username === viewer)) return true;
  if (names(mr.commenters).includes(viewer)) return true;
  if (names(mr.participants).includes(viewer)) return true;
  return false;
}

export function normalizeMergeRequest(
  mr: RawMergeRequest,
  viewer: string,
): PullRequest {
  const iid = Number.parseInt(mr.iid, 10);
  return {
    id: mr.id,
    provider: "gitlab",
    // A malformed iid yields NaN, which passes `isPullRequest` (`typeof NaN` is
    // "number") and then poisons every `a.number - b.number` comparison it meets.
    number: Number.isInteger(iid) ? iid : 0,
    title: sanitize(mr.title),
    url: safeUrl(mr.webUrl),
    repo: sanitize(mr.project?.fullPath ?? "unknown/unknown"),
    author: sanitize(mr.author?.username ?? "ghost"),
    createdAt: canonicalTime(mr.createdAt),
    updatedAt: canonicalTime(mr.updatedAt),
    // Validated here so producer and validator agree: a row `isPullRequest` would
    // reject is dropped on the next read, which flags the provider incomplete and
    // resets its baseline.
    headOid: OID.test(mr.diffHeadSha ?? "") ? (mr.diffHeadSha ?? "") : "",
    baseRef: sanitize(mr.targetBranch),
    // `draft` is authoritative; the `WIP:` title prefix is not — two of the
    // driver's MRs are titled WIP: and report draft false.
    draft: mr.draft,
    verdict: verdictOf(mr),
    standing: standingOf(mr, viewer),
    checks: toChecksFromPipeline(mr.headPipeline?.status),
    merge: toMergeStateFromStatus(mr.mergeStatusEnum, mr.conflicts, mr.detailedMergeStatus),
    staleBlock: staleBlockOf(mr, viewer),
    // GitLab has no CODEOWNERS-equivalent flag on a review request.
    viaCodeOwners: false,
    otherReviews: [
      ...new Set([...names(mr.approvedBy), ...names(mr.changeRequesters)]),
    ].filter((u) => u !== viewer).length,
    stacks: stacksOf(mr),
  };
}

interface ScanData {
  currentUser: { username: string } | null;
  projects: {
    nodes: Array<{
      fullPath: string;
      mergeRequests: {
        count: number;
        pageInfo: { hasNextPage: boolean };
        nodes: RawMergeRequest[];
      };
    }>;
  };
}

/**
 * The single HTTP path to GitLab. The scan and the census share it so status,
 * non-JSON body and GraphQL `errors` are handled once — and so neither drifts
 * onto `glab api graphql`, which cannot send list variables at all and hijacks
 * any document mentioning `__type` or `__schema`.
 */
async function graphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "prq",
    },
    body: JSON.stringify({ query, variables }),
    signal,
  });

  const body = await response.text();
  if (!response.ok) {
    throw new GitLabError(`GitLab returned ${response.status}`);
  }
  let parsed: {
    data?: unknown;
    errors?: Array<{ message?: string; extensions?: { code?: string } }>;
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new GitLabError("GitLab returned a non-JSON body");
  }
  if (parsed.errors?.length) {
    const first = parsed.errors[0];
    // Prefer the structural code over free text, as the GitHub path does — and
    // sanitise the text when there is no code, because a server-supplied message
    // reaches the terminal.
    const detail = first?.extensions?.code ?? sanitize(first?.message ?? "unknown");
    throw new GitLabError(
      `GitLab reported ${parsed.errors.length} error(s): ${detail}`,
    );
  }
  if (!parsed.data) throw new GitLabError("GitLab returned no data");
  return parsed.data as T;
}

const HOST = "gitlab.com";

/** A token this close to lapsing is treated as already gone, so a slow scan cannot outlive it. */
const EXPIRY_SKEW_MS = 60_000;

async function glab(args: string[]): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn(["glab", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

/** A single `glab config get` value, or "" when glab cannot answer. */
async function glabConfig(key: string): Promise<string> {
  const { out, code } = await glab(["config", "get", key, "--host", HOST]);
  return code === 0 ? out.trim() : "";
}

/**
 * Whether the stored token must be refreshed before it is used.
 *
 * Only OAuth tokens expire; a personal access token is left alone. An OAuth token
 * with no readable expiry is refreshed rather than trusted, because the stored
 * value cannot be shown to be live and the cost of being wrong is a bare 401.
 *
 * Exported for the tests: the decision is worth pinning down without spawning.
 */
export function needsRefresh(isOAuth: string, expiry: string, now = new Date()): boolean {
  if (isOAuth.trim() !== "true") return false;
  const at = Date.parse(expiry);
  if (Number.isNaN(at)) return true;
  return at - now.getTime() <= EXPIRY_SKEW_MS;
}

/**
 * Makes glab perform its own authenticated call, which is what triggers the token
 * refresh and the write-back. Deliberately ignores the outcome: if glab cannot
 * refresh, the token read that follows either still works or fails with glab's own
 * message, both of which say more than anything invented here.
 */
async function refreshViaGlab(): Promise<void> {
  await glab(["api", "/user"]);
}

export const gitlab: ProviderClient = {
  provider: "gitlab",

  async token(): Promise<string> {
    const fromEnv = process.env.GITLAB_TOKEN;
    if (fromEnv) return fromEnv;

    // `glab auth login` can store either a long-lived personal access token or a
    // two-hour OAuth one. `glab config get` reads whatever is stored *without*
    // refreshing it, so an OAuth token that lapsed since the last `glab` command
    // would be handed over expired and the scan would fail with a bare 401.
    if (needsRefresh(await glabConfig("is_oauth2"), await glabConfig("oauth2_expiry_date"))) {
      await refreshViaGlab();
    }

    const { out, err, code } = await glab(["config", "get", "token", "--host", HOST]);
    const token = out.trim();
    if (code !== 0 || token === "") {
      const detail = err.trim();
      throw new GitLabError(
        `no GitLab token — run \`glab auth login\`, or set GITLAB_TOKEN${detail ? `\n  glab: ${detail}` : ""}`,
      );
    }
    return token;
  },

  async scan(projects, token, signal): Promise<ProviderScan> {
    if (projects.length === 0) return { rows: [], failed: [], viewer: "" };

    const data = await graphql<ScanData>(
      token,
      SCAN_QUERY,
      { paths: projects, first: PAGE_SIZE },
      signal,
    );
    const viewer = data.currentUser?.username ?? "";
    if (viewer === "") {
      throw new GitLabError("GitLab did not identify the authenticated user");
    }

    const returned = new Set(data.projects.nodes.map((n) => n.fullPath));
    // A path GitLab cannot see is omitted silently — HTTP 200, no error, just
    // fewer nodes. Without this check a typo is indistinguishable from a project
    // with no open MRs. Compared by value: the order is arbitrary.
    const failed = projects
      .filter((p) => !returned.has(p))
      .map((p) => `gitlab: ${p} is unreachable — check the path and your access`);

    const rows: PullRequest[] = [];
    for (const project of data.projects.nodes) {
      const { count, pageInfo, nodes } = project.mergeRequests;
      // GitLab cannot filter by involvement server-side, so the scan breadth is
      // the *whole* project: everything past this window is discarded. Silence
      // here would be worse than a visible failure — the partial set would commit
      // as a baseline, and because the window is newest-first it slides, churning
      // rows out as spurious `left` on every later sync.
      if (pageInfo.hasNextPage) {
        failed.push(
          `gitlab: ${project.fullPath} has ${count} open MRs, only ${nodes.length} fetched — narrow the list or wait for paging`,
        );
      }
      for (const mr of nodes) {
        // The involvement filter GitLab cannot express server-side.
        if (concernsViewer(mr, viewer)) rows.push(normalizeMergeRequest(mr, viewer));
      }
    }

    return { rows, failed, viewer };
  },
};

/**
 * The census selection, verified live against a 329-MR project: one request per
 * page of 100, ~2.6s, cursor paging present, no errors. `state: all` is the whole
 * point — the scan asks `state: opened` and has therefore never seen a merged MR.
 *
 * `$path` is bound as a variable rather than interpolated. Project paths come
 * from config, are validated per provider before they reach here, and a variable
 * keeps a stray brace a bad path instead of a query rewrite.
 *
 * One deviation from the brief, established by probing the live API: GitLab *does*
 * expose `closedAt` on a merge request, and it is populated on closed MRs (iid
 * 320: closedAt 2026-04-22T12:38:14Z). Selecting it beats deriving the date from
 * `updatedAt`, which drifts forward every time somebody comments on a closed MR.
 */
const CENSUS_QUERY = `
query Census($path: ID!, $first: Int!, $after: String) {
  project(fullPath: $path) {
    mergeRequests(state: all, first: $first, after: $after) {
      count
      pageInfo { hasNextPage endCursor }
      nodes {
        iid title webUrl state draft createdAt updatedAt mergedAt closedAt
        author { username }
        mergeUser { username }
        diffStatsSummary { additions deletions fileCount }
        approvedBy { nodes { username } }
        reviewers { nodes { username mergeRequestInteraction { reviewState } } }
      }
    }
  }
}`;

interface RawCensusMr {
  /** A string over the wire — `"329"` — while `CensusPr.number` is a number. */
  iid: string;
  title: string | null;
  webUrl: string | null;
  /** Lowercase: `opened`, `merged`, `closed`, `locked`. `toPrState` folds all four. */
  state: string | null;
  draft: boolean | null;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  author: UserRef | null;
  mergeUser: UserRef | null;
  /** Null on an MR whose diff GitLab has not computed. */
  diffStatsSummary: { additions: number; deletions: number; fileCount: number } | null;
  approvedBy: { nodes: UserRef[] } | null;
  reviewers: {
    nodes: Array<UserRef & { mergeRequestInteraction: { reviewState: string | null } | null }>;
  } | null;
}

interface CensusData {
  /** Null — with HTTP 200 and no `errors` — when the path is unknown or hidden. */
  project: {
    mergeRequests: {
      count: number;
      pageInfo: { hasNextPage: boolean; endCursor: string | null } | null;
      nodes: RawCensusMr[] | null;
    };
  } | null;
}

/**
 * Review acts for one merge request.
 *
 * Two sources describing one truth: `approvedBy` lists the current approvals, and
 * a reviewer's `reviewState` may say `APPROVED` about the same act. Keying by
 * reviewer *and* act collapses that pair into one row, while still allowing one
 * reviewer to hold two distinct acts.
 *
 * `at` is null on every row. Neither source carries a timestamp, so review latency
 * here is unknowable rather than zero — which is why the census reports
 * `reviewPrecision: "approximate"` and anything latency-shaped must be withheld.
 */
function censusReviewsOf(repo: string, number: number, mr: RawCensusMr): CensusReview[] {
  const rows: CensusReview[] = [];
  const seen = new Set<string>();
  const add = (username: unknown, act: ReviewAct | null): void => {
    const reviewer = toLogin(username);
    if (reviewer === "" || act === null) return;
    const key = `${reviewer}\u0000${act}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ provider: "gitlab", repo, number, reviewer, act, at: null });
  };
  for (const user of mr.approvedBy?.nodes ?? []) add(user?.username, "approved");
  for (const user of mr.reviewers?.nodes ?? []) {
    add(user?.username, toReviewAct(user?.mergeRequestInteraction?.reviewState));
  }
  return rows;
}

function censusPrOf(repo: string, mr: RawCensusMr): CensusPr {
  const iid = Number.parseInt(mr.iid, 10);
  const state = toPrState(mr.state);
  const updatedAt = toTime(mr.updatedAt) ?? "";
  return {
    provider: "gitlab",
    repo,
    // A malformed iid yields NaN, which is still `typeof "number"` and would then
    // poison every numeric comparison and every keyed lookup it reached.
    number: Number.isInteger(iid) ? iid : 0,
    state,
    draft: mr.draft === true,
    title: sanitize(mr.title ?? ""),
    url: safeUrl(mr.webUrl),
    author: toLogin(mr.author?.username),
    createdAt: toTime(mr.createdAt) ?? "",
    updatedAt,
    mergedAt: toTime(mr.mergedAt),
    // `closedAt` is selected and authoritative; `updatedAt` stands in only when a
    // closed MR carries none, which older rows do. Null on anything not closed, so
    // nothing downstream mistakes an open MR's last touch for a closing date.
    closedAt: state === "closed" ? (toTime(mr.closedAt) ?? (updatedAt || null)) : null,
    additions: toCount(mr.diffStatsSummary?.additions),
    deletions: toCount(mr.diffStatsSummary?.deletions),
    files: toCount(mr.diffStatsSummary?.fileCount),
    mergedBy: state === "merged" ? toLogin(mr.mergeUser?.username) : "",
  };
}

export const gitlabCensus: CensusClient = {
  async censusRepo(repo, since, signal): Promise<RepoCensus> {
    // The scan's token path, including the OAuth staleness check, for a sharper
    // reason than the scan has: a census is ~6 pages at ~2.6s each against the
    // configured projects, and glab's OAuth token lives two hours, so a token
    // that lapses mid-walk abandons a multi-minute walk with a bare 401.
    const token = await gitlab.token();

    // Both sides of the comparison must be canonical: GitLab returns offsets, not
    // always `Z`, and a watermark is caller-supplied. Compared as strings, which
    // is only chronological once the offsets agree.
    const watermark = since === null || since === "" ? null : canonicalTime(since);

    const prs: CensusPr[] = [];
    const reviews: CensusReview[] = [];
    let after: string | null = null;
    let truncated = false;
    let failed: string | null = null;

    try {
      for (let page = 0; ; page += 1) {
        if (page >= MAX_PAGES) {
          // A prefix is reported as one, never returned as if it were the whole.
          truncated = true;
          break;
        }
        // A census is minutes long, so cancellation is checked at every page
        // boundary as well as inside the request.
        signal?.throwIfAborted();

        // Annotated, not inferred: `after` is reassigned from this response, and
        // the object literal's contextual type otherwise makes the compiler
        // chase `data` -> `endCursor` -> `after` -> `data` and fall back to
        // `any` (TS7022).
        const data: CensusData = await graphql<CensusData>(
          token,
          CENSUS_QUERY,
          { path: repo, first: CENSUS_PAGE, after },
          signal,
        );
        const connection = data.project?.mergeRequests;
        if (!connection) {
          // HTTP 200, no `errors`, just a null project. The scan's wording, since
          // it is the same condition: unknown path or no access.
          failed = `gitlab: ${repo} is unreachable — check the path and your access`;
          break;
        }

        let reached = false;
        for (const node of connection.nodes ?? []) {
          const createdAt = toTime(node.createdAt) ?? "";
          // The connection is ordered created_at DESC (verified live: the highest
          // iid arrives first), so `createdAt` is the only key monotone across
          // this stream and the early stop has to cut on it. The cost is real and
          // one-sided: an old MR updated after the watermark is not revisited,
          // where GitHub's UPDATED_AT-ordered walk would catch it. A caller that
          // needs late edits to old MRs must walk without `since`.
          if (watermark !== null && createdAt !== "" && createdAt <= watermark) {
            reached = true;
            break;
          }
          const row = censusPrOf(repo, node);
          prs.push(row);
          reviews.push(...censusReviewsOf(repo, row.number, node));
        }
        if (reached) break;

        const { hasNextPage, endCursor } = connection.pageInfo ?? {};
        // No cursor means there is nowhere to go, whatever `hasNextPage` claims —
        // re-requesting page one forever is the failure mode `MAX_PAGES` bounds.
        if (hasNextPage !== true || !endCursor) break;
        after = endCursor;
      }
    } catch (error) {
      // The caller's own abort is not a project failure; reporting it as one would
      // mark every repo unreachable on a cancelled census.
      if (signal?.aborted) throw error;
      const detail = sanitize(error instanceof Error ? error.message : String(error));
      // A token this process holds must never reach output, and a failure message
      // can carry server text. Replacing the exact secret is the only guard that
      // does not depend on guessing its shape: `glpat-`, `gloas-` and OAuth
      // bearers all differ.
      failed = `gitlab: ${repo} census failed — ${token === "" ? detail : detail.split(token).join("***")}`;
    }

    return {
      provider: "gitlab",
      repo,
      // `failed` means the rows cannot be trusted, so none of them are handed on —
      // a half-walked project must not read as a complete one.
      prs: failed === null ? prs : [],
      reviews: failed === null ? reviews : [],
      // Never `exact`: no GitLab review source carries a timestamp.
      reviewPrecision: "approximate",
      failed,
      truncated: failed === null && truncated,
    };
  },
};
