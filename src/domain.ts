/**
 * Domain model for the PR review dashboard.
 *
 * Vocabulary is defined in CONTEXT.md. Bucket rules come from wayfinder ticket
 * 0007; standing derivation from ticket 0005 and its amendment.
 *
 * Everything here is pure — no I/O, no API shapes leaking outward.
 */

export type Verdict =
  | "approved"
  | "changes-requested"
  | "awaiting-review"
  | "review-optional";

export type Standing =
  | "mine"
  | "awaiting-me"
  | "i-requested-changes"
  | "i-approved"
  | "i-commented"
  | "not-involved";

export type Checks = "success" | "failing" | "pending" | "none";
export type MergeState = "clean" | "conflicted" | "unknown";

/** Raw GraphQL selection. Field names mirror the API exactly. */
export interface RawReview {
  state: string;
  author: { login: string } | null;
  commit: { oid: string } | null;
}

export interface RawPullRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  headRefOid: string;
  mergeable: string | null;
  reviewDecision: string | null;
  author: { login: string } | null;
  repository: { nameWithOwner: string };
  viewerDidAuthor: boolean;
  viewerLatestReview: { state: string } | null;
  viewerLatestReviewRequest: { asCodeOwner: boolean | null } | null;
  latestOpinionatedReviews: { nodes: RawReview[] } | null;
  stack: { number: number; size: number } | null;
  stackEntry: { position: number } | null;
  commits: {
    nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }>;
  };
}

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  /** Validated https URL, or null when the API handed us something else. */
  url: string | null;
  repo: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
  verdict: Verdict;
  standing: Standing;
  checks: Checks;
  merge: MergeState;
  /** My changes-request no longer describes the head commit. */
  staleBlock: boolean;
  /** The review request reached me via CODEOWNERS rather than by name. */
  viaCodeOwners: boolean;
  /** Opinionated reviews by anyone other than the viewer. */
  otherReviews: number;
  stack: { number: number; size: number; position: number } | null;
}

/**
 * Control and format characters, stripped from every remote string.
 *
 * `Cc` covers C0/C1 — a newline in a PR title breaks the one-row-per-PR
 * assumption in the renderer's viewport maths and blanks the dashboard; BEL
 * reaches the terminal raw. `Cf` covers the bidi overrides that let a title
 * render reversed and spoof a repo name.
 */
const CONTROL_CHARS = /[\p{Cc}\p{Cf}]/gu;

export function sanitize(text: string): string {
  return text.replace(CONTROL_CHARS, " ");
}

/**
 * Only https survives. Everything downstream either spawns `open` with this or
 * embeds it in an OSC 8 hyperlink, so a `javascript:`, `file:` or
 * escape-sequence-bearing URL is a live injection sink.
 */
export function safeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export function toVerdict(reviewDecision: string | null): Verdict {
  switch (reviewDecision) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "REVIEW_REQUIRED":
      return "awaiting-review";
    default:
      // Null is a real fourth case: the repository does not require review.
      return "review-optional";
  }
}

export function toChecks(state: string | null | undefined): Checks {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failing";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

export function toMergeState(mergeable: string | null): MergeState {
  switch (mergeable) {
    case "MERGEABLE":
      return "clean";
    case "CONFLICTING":
      return "conflicted";
    default:
      return "unknown";
  }
}

/**
 * The viewer's latest *opinionated* review.
 *
 * Deliberately not `viewerLatestReview`: a later comment-only review does not
 * dismiss a standing changes-request, but it does become the "latest" review,
 * which would silently downgrade a live block. See ticket 0005's amendment.
 */
function viewerOpinion(
  pr: RawPullRequest,
  viewer: string,
): RawReview | undefined {
  return pr.latestOpinionatedReviews?.nodes.find(
    (r) => r.author?.login === viewer,
  );
}

export function standingOf(pr: RawPullRequest, viewer: string): Standing {
  if (pr.viewerDidAuthor) return "mine";
  // A live request outranks any prior opinion of mine — including the
  // re-request case, where I reviewed and the author has asked again.
  if (pr.viewerLatestReviewRequest) return "awaiting-me";

  const opinion = viewerOpinion(pr, viewer);
  if (opinion?.state === "CHANGES_REQUESTED") return "i-requested-changes";
  if (opinion?.state === "APPROVED") return "i-approved";
  if (pr.viewerLatestReview) return "i-commented";
  return "not-involved";
}

export function isStaleBlock(pr: RawPullRequest, viewer: string): boolean {
  const opinion = viewerOpinion(pr, viewer);
  if (opinion?.state !== "CHANGES_REQUESTED") return false;
  // A null commit means the reviewed commit is gone — almost always a force
  // push, which is exactly the stale case. Resolving it the other way would
  // hide the most actionable state on the board inside "nothing has happened".
  return opinion.commit === null || opinion.commit.oid !== pr.headRefOid;
}

export function normalize(pr: RawPullRequest, viewer: string): PullRequest {
  const opinionated = pr.latestOpinionatedReviews?.nodes ?? [];
  return {
    id: pr.id,
    number: pr.number,
    title: sanitize(pr.title),
    url: safeUrl(pr.url),
    repo: sanitize(pr.repository.nameWithOwner),
    author: sanitize(pr.author?.login ?? "ghost"),
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    draft: pr.isDraft,
    verdict: toVerdict(pr.reviewDecision),
    standing: standingOf(pr, viewer),
    checks: toChecks(pr.commits.nodes[0]?.commit.statusCheckRollup?.state),
    merge: toMergeState(pr.mergeable),
    staleBlock: isStaleBlock(pr, viewer),
    viaCodeOwners: pr.viewerLatestReviewRequest?.asCodeOwner === true,
    otherReviews: opinionated.filter((r) => r.author?.login !== viewer).length,
    stack:
      pr.stack && pr.stackEntry
        ? {
            number: pr.stack.number,
            size: pr.stack.size,
            position: pr.stackEntry.position,
          }
        : null,
  };
}

export const BUCKETS = [
  { id: 1, label: "Awaiting me" },
  { id: 2, label: "I blocked it, and it moved" },
  { id: 3, label: "Mine, ready to land" },
  { id: 4, label: "Mine, needs work" },
  { id: 5, label: "Mine, waiting" },
  { id: 6, label: "I blocked it, unchanged" },
  { id: 7, label: "Ambient" },
] as const;

export type BucketId = (typeof BUCKETS)[number]["id"];

/** First match wins. Buckets 1/2/6 and 3/4/5 are disjoint by construction. */
export function bucketOf(pr: PullRequest): BucketId {
  if (pr.standing === "awaiting-me") return 1;
  if (pr.standing === "i-requested-changes") return pr.staleBlock ? 2 : 6;
  if (pr.standing === "mine") {
    // `none` (no CI configured) and `unknown` (GitHub has not computed
    // mergeability yet) are non-committal, not blocking. Demanding
    // success/clean exactly made bucket 3 unreachable on a repo without CI,
    // and made a PR flip out of it between scans once mergeability resolved.
    if (
      pr.verdict === "approved" &&
      pr.checks !== "failing" &&
      pr.checks !== "pending" &&
      pr.merge !== "conflicted"
    ) {
      return 3;
    }
    if (
      pr.verdict === "changes-requested" ||
      pr.checks === "failing" ||
      pr.merge === "conflicted"
    ) {
      return 4;
    }
    return 5;
  }
  return 7;
}

const asc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const desc = (a: string, b: string) => -asc(a, b);

/**
 * Per-bucket ordering. Drafts always sort last within their bucket; the
 * deterministic repo+number tiebreak stops the list shuffling between scans.
 */
export function compareWithin(
  bucket: BucketId,
  a: PullRequest,
  b: PullRequest,
): number {
  if (a.draft !== b.draft) return a.draft ? 1 : -1;

  if (bucket === 1 && a.viaCodeOwners !== b.viaCodeOwners) {
    return a.viaCodeOwners ? 1 : -1;
  }

  const primary =
    bucket === 1 || bucket === 5
      ? asc(a.createdAt, b.createdAt)
      : bucket === 3
        ? asc(a.updatedAt, b.updatedAt)
        : desc(a.updatedAt, b.updatedAt);
  if (primary !== 0) return primary;

  return asc(a.repo, b.repo) || a.number - b.number;
}

export interface Bucket {
  id: BucketId;
  label: string;
  items: PullRequest[];
}

/** Empty buckets are omitted entirely — no header, no scaffolding. */
export function groupIntoBuckets(prs: PullRequest[]): Bucket[] {
  return BUCKETS.map(({ id, label }) => ({
    id,
    label,
    items: prs
      .filter((pr) => bucketOf(pr) === id)
      .sort((a, b) => compareWithin(id, a, b)),
  })).filter((bucket) => bucket.items.length > 0);
}

/** The ungrouped view: one flat list, most recently updated first. */
export function flatten(prs: PullRequest[]): PullRequest[] {
  return [...prs].sort(
    (a, b) => desc(a.updatedAt, b.updatedAt) || asc(a.repo, b.repo) || a.number - b.number,
  );
}

const VERDICTS: Record<Verdict, true> = {
  approved: true,
  "changes-requested": true,
  "awaiting-review": true,
  "review-optional": true,
};
const STANDINGS: Record<Standing, true> = {
  mine: true,
  "awaiting-me": true,
  "i-requested-changes": true,
  "i-approved": true,
  "i-commented": true,
  "not-involved": true,
};
const CHECKS: Record<Checks, true> = {
  success: true,
  failing: true,
  pending: true,
  none: true,
};
const MERGE_STATES: Record<MergeState, true> = {
  clean: true,
  conflicted: true,
  unknown: true,
};

/**
 * Validates a PR that did not come straight from `normalize` — in practice, one
 * read back from the cache file. Anything on disk is untrusted input: it is
 * reachable by any process that can write one file in $HOME, and its `url`
 * reaches both `open` and an OSC 8 escape sequence.
 */
export function isPullRequest(value: unknown): value is PullRequest {
  if (value === null || typeof value !== "object") return false;
  const pr = value as Record<string, unknown>;
  return (
    typeof pr.id === "string" &&
    typeof pr.number === "number" &&
    typeof pr.title === "string" &&
    (pr.url === null || (typeof pr.url === "string" && safeUrl(pr.url) === pr.url)) &&
    typeof pr.repo === "string" &&
    typeof pr.author === "string" &&
    typeof pr.createdAt === "string" &&
    typeof pr.updatedAt === "string" &&
    typeof pr.draft === "boolean" &&
    typeof pr.staleBlock === "boolean" &&
    typeof pr.viaCodeOwners === "boolean" &&
    typeof pr.otherReviews === "number" &&
    VERDICTS[pr.verdict as Verdict] === true &&
    STANDINGS[pr.standing as Standing] === true &&
    CHECKS[pr.checks as Checks] === true &&
    MERGE_STATES[pr.merge as MergeState] === true &&
    (pr.stack === null ||
      (typeof pr.stack === "object" &&
        pr.stack !== null &&
        typeof (pr.stack as Record<string, unknown>).number === "number" &&
        typeof (pr.stack as Record<string, unknown>).size === "number" &&
        typeof (pr.stack as Record<string, unknown>).position === "number"))
  );
}
