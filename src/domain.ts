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
  baseRefName: string;
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

export type Provider = "github" | "gitlab";

/**
 * How well a provider filled a field.
 *
 * Rides on the row, never inferred from the provider: capability is
 * per-*project*. A blocking review is reportable on a paid GitLab project and
 * invisible on a free one, inside a single scan.
 */
export type Precision = "exact" | "approximate";

/**
 * A changes-request of mine that no longer describes the head.
 *
 * `null` when the provider cannot tell. GitHub answers exactly, by comparing the
 * reviewed commit against the head. GitLab attaches no commit to a review state,
 * so it compares timestamps instead and is undecidable when the review carries no
 * timestamp — 20% of its blocking cohort when measured.
 */
export interface StaleBlock {
  value: boolean;
  precision: Precision;
}

/**
 * One stack a PR belongs to.
 *
 * Plural on the model because GitLab membership is a *path*, not a partition —
 * one MR can sit in several stacks at once. `precision` is `approximate` on
 * GitLab because it counts only open layers and so cannot express a partly-landed
 * `5/6`.
 *
 * `id` is the focus key, so it must be unique across the whole board, not just
 * within one repository: GitHub's stack numbers restart per repo, so they are
 * namespaced by it. GitLab has no stack identity, so the bottom member's node id
 * stands in — already globally unique.
 */
export interface StackMembership {
  id: string;
  size: number;
  position: number;
  precision: Precision;
}

export interface PullRequest {
  id: string;
  provider: Provider;
  number: number;
  title: string;
  /** Validated https URL, or null when the API handed us something else. */
  url: string | null;
  repo: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  /** Head commit. A change between syncs is a push. */
  headOid: string;
  /** Base branch. A change between syncs is a retarget, which the API never marks. */
  baseRef: string;
  draft: boolean;
  verdict: Verdict;
  standing: Standing;
  checks: Checks;
  merge: MergeState;
  staleBlock: StaleBlock | null;
  /** The review request reached me via CODEOWNERS rather than by name. */
  viaCodeOwners: boolean;
  /** Opinionated reviews by anyone other than the viewer. */
  otherReviews: number;
  stacks: StackMembership[];
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

/**
 * Normalises a timestamp to UTC ISO-8601 with a `Z` suffix.
 *
 * Everything downstream orders timestamps by **string** comparison — the bucket
 * sorts, the flat view, the age display. That is only equivalent to chronological
 * order when every value shares one offset. GitHub returns `Z` throughout, but
 * GitLab does not: `committedDate` comes back as `2026-04-16T17:54:22+02:00`,
 * which is 15:54Z and therefore *earlier* than a sibling `16:23:37Z` while
 * sorting *later* lexicographically. Canonicalising here keeps the cheap string
 * comparisons correct for any provider.
 *
 * An unparseable value is passed through rather than discarded: it is display
 * data, and losing a PR over a malformed date would be worse than mis-sorting it.
 */
export function canonicalTime(raw: string): string {
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
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

/**
 * GitHub answers this exactly: the reviewed commit is on the record, so it can be
 * compared with the head. `null` is never returned here — only GitLab, which
 * attaches no commit to a review state, has to say "cannot tell".
 */
export function isStaleBlock(pr: RawPullRequest, viewer: string): StaleBlock | null {
  const opinion = viewerOpinion(pr, viewer);
  if (opinion?.state !== "CHANGES_REQUESTED") return null;
  // A null commit means the reviewed commit is gone — almost always a force
  // push, which is exactly the stale case. Resolving it the other way would
  // hide the most actionable state on the board inside "nothing has happened".
  const moved = opinion.commit === null || opinion.commit.oid !== pr.headRefOid;
  return { value: moved, precision: "exact" };
}

export function normalize(pr: RawPullRequest, viewer: string): PullRequest {
  const opinionated = pr.latestOpinionatedReviews?.nodes ?? [];
  return {
    id: pr.id,
    provider: "github",
    number: pr.number,
    title: sanitize(pr.title),
    url: safeUrl(pr.url),
    repo: sanitize(pr.repository.nameWithOwner),
    author: sanitize(pr.author?.login ?? "ghost"),
    createdAt: canonicalTime(pr.createdAt),
    updatedAt: canonicalTime(pr.updatedAt),
    // Validated at the producer so it agrees with `isPullRequest` by construction.
    // A row whose oid the validator would reject is silently dropped on the next
    // read, which flags the whole provider incomplete and resets its baseline —
    // far out of proportion to one odd sha.
    headOid: OID.test(pr.headRefOid) ? pr.headRefOid : "",
    baseRef: sanitize(pr.baseRefName),
    draft: pr.isDraft,
    verdict: toVerdict(pr.reviewDecision),
    standing: standingOf(pr, viewer),
    checks: toChecks(pr.commits.nodes[0]?.commit.statusCheckRollup?.state),
    merge: toMergeState(pr.mergeable),
    staleBlock: isStaleBlock(pr, viewer),
    viaCodeOwners: pr.viewerLatestReviewRequest?.asCodeOwner === true,
    otherReviews: opinionated.filter((r) => r.author?.login !== viewer).length,
    // GitHub membership is a partition, so at most one entry, and its counts
    // include merged layers — hence `exact`.
    stacks:
      pr.stack && pr.stackEntry
        ? [
            {
              // Stack numbers restart per repository, so a bare number focuses
              // "stack 3" in every repo at once.
              id: `${pr.repository.nameWithOwner}#${pr.stack.number}`,
              size: pr.stack.size,
              position: pr.stackEntry.position,
              precision: "exact",
            },
          ]
        : [],
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
  if (pr.standing === "i-requested-changes") {
    // `null` means the provider cannot tell whether the head moved. Resolved
    // toward stale, following the precedent 0005's second amendment set for
    // GitHub's null-commit case: every other unknown here resolves to the
    // non-alarming reading, but this is the one place where that would suppress
    // action. Ticket 0021 owns the final call.
    return pr.staleBlock === null || pr.staleBlock.value ? 2 : 6;
  }
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

  // Total across providers: a GitHub repo and a GitLab project can share a full
  // path, and without the last term those two rows would sort in input order —
  // which is exactly the shuffling between scans this tiebreak exists to stop.
  return asc(a.repo, b.repo) || a.number - b.number || asc(a.provider, b.provider);
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
    (a, b) =>
      desc(a.updatedAt, b.updatedAt) ||
      asc(a.repo, b.repo) ||
      a.number - b.number ||
      asc(a.provider, b.provider),
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
/** Git object ids only; `headOid` is rendered and compared, never executed. */
export const OID = /^[0-9a-f]{0,64}$/;

/**
 * A string that survived sanitisation unchanged. This is the same fixed-point
 * test `url` uses, and it is what makes the check a real trust boundary rather
 * than a type assertion: sanitisation lives in `normalize`, and anything read
 * back off disk never passes through `normalize`.
 */
export const isClean = (value: unknown): value is string =>
  typeof value === "string" && sanitize(value) === value;

export function isPullRequest(value: unknown): value is PullRequest {
  if (value === null || typeof value !== "object") return false;
  const pr = value as Record<string, unknown>;
  return (
    typeof pr.id === "string" &&
    typeof pr.number === "number" &&
    isClean(pr.title) &&
    (pr.url === null || (typeof pr.url === "string" && safeUrl(pr.url) === pr.url)) &&
    isClean(pr.repo) &&
    isClean(pr.author) &&
    typeof pr.createdAt === "string" &&
    typeof pr.updatedAt === "string" &&
    typeof pr.headOid === "string" &&
    OID.test(pr.headOid) &&
    isClean(pr.baseRef) &&
    typeof pr.draft === "boolean" &&
    isStaleBlockShape(pr.staleBlock) &&
    typeof pr.viaCodeOwners === "boolean" &&
    typeof pr.otherReviews === "number" &&
    PROVIDERS[pr.provider as Provider] === true &&
    urlMatchesProvider(pr.url, pr.provider as Provider) &&
    VERDICTS[pr.verdict as Verdict] === true &&
    STANDINGS[pr.standing as Standing] === true &&
    CHECKS[pr.checks as Checks] === true &&
    MERGE_STATES[pr.merge as MergeState] === true &&
    Array.isArray(pr.stacks) &&
    pr.stacks.every(isStackShape)
  );
}

const PROVIDER_HOSTS: Record<Provider, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
};

/**
 * A stored row's link must belong to the forge it claims. Without this, `url` was
 * merely "some https address", and a tampered row could name one provider while
 * pointing its clickable link and its `open` target anywhere.
 */
function urlMatchesProvider(url: unknown, provider: Provider): boolean {
  if (url === null) return true;
  if (typeof url !== "string") return false;
  try {
    return new URL(url).hostname === PROVIDER_HOSTS[provider];
  } catch {
    return false;
  }
}

const PROVIDERS: Record<Provider, true> = { github: true, gitlab: true };
const PRECISIONS: Record<Precision, true> = { exact: true, approximate: true };

function isStaleBlockShape(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const sb = value as Record<string, unknown>;
  return (
    typeof sb.value === "boolean" && PRECISIONS[sb.precision as Precision] === true
  );
}

function isStackShape(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    (s.id === null || typeof s.id === "string") &&
    typeof s.size === "number" &&
    typeof s.position === "number" &&
    PRECISIONS[s.precision as Precision] === true
  );
}
