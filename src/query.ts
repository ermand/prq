/**
 * GraphQL for the scan and the census.
 *
 * A scan is two searches, not a walk over the repository list — see wayfinder
 * ticket 0013. `involves:` covers author, assignee, mentions and commenter but
 * *excludes* review requests, so the queue needs its own query; search
 * qualifiers are ANDed with no way to OR them.
 */

import { REVIEW_PAGE } from "./census";

/** Every field the domain model needs, in one round trip. */
export const PR_FIELDS = `
  id number title url isDraft createdAt updatedAt headRefOid baseRefName
  mergeable reviewDecision
  author { login }
  repository { nameWithOwner }
  viewerDidAuthor
  viewerLatestReview { state }
  viewerLatestReviewRequest { asCodeOwner }
  latestOpinionatedReviews(first: 100) { nodes { state author { login } commit { oid } } }
  stack { number size }
  stackEntry { position }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

export const SCAN_QUERY = `
query Scan($q: String!, $first: Int!, $after: String) {
  rateLimit { cost remaining }
  viewer { login }
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
}`;

/** The two halves of a scan. Order is the order they are rendered in. */
export const SCAN_FILTERS = ["review-requested:@me", "involves:@me"] as const;

export type ScanFilter = (typeof SCAN_FILTERS)[number];

export function buildSearchQuery(repos: string[], filter: ScanFilter): string {
  if (repos.length === 0) {
    throw new Error("no repositories configured — nothing to scan");
  }
  // Validated here, at the sink, not only in the config loader: anything that
  // is not owner/name can inject a qualifier and widen the search scope.
  const bad = repos.filter((repo) => !isValidRepo(repo));
  if (bad.length > 0) {
    throw new Error(`not owner/name: ${bad.map((r) => JSON.stringify(r)).join(", ")}`);
  }
  const scope = repos.map((r) => `repo:${r}`).join(" ");
  return `is:pr is:open ${scope} ${filter}`;
}

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export function isValidRepo(repo: string): boolean {
  return REPO_PATTERN.test(repo);
}

/**
 * GraphQL for the census.
 *
 * The scan cannot answer census questions: search is ego-scoped and open-only,
 * and `search` refuses to page past 1000 results, which the 3309-PR repo blows
 * straight through. The repository connection has no such ceiling.
 *
 * This exact selection was measured live against that repo: 100 nodes with
 * their reviews nested cost **1** rate-limit point per page and returned in
 * about 7s with no errors. Nesting the reviews is what keeps it at one point —
 * a per-PR follow-up query would cost 34 pages plus 3309 requests.
 *
 * UPDATED_AT DESC is load-bearing: it is what makes an incremental census sound.
 * Newest first means the first row older than the caller's watermark ends the
 * walk, with no risk of an older-but-unseen row hiding on a later page.
 */
export const CENSUS_QUERY = `
query Census($owner: String!, $name: String!, $first: Int!, $after: String) {
  rateLimit { cost remaining }
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, after: $after, states: [OPEN, CLOSED, MERGED], orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url state isDraft createdAt updatedAt mergedAt closedAt
        additions deletions changedFiles
        author { login }
        mergedBy { login }
        reviews(first: ${REVIEW_PAGE}) { nodes { state submittedAt author { login } } }
      }
    }
  }
}`;

/**
 * Splits `owner/name` for the census query's two variables. Validated here, at
 * the sink, for the same reason `buildSearchQuery` validates: the halves reach a
 * query, and `owner/name/extra` would otherwise be split into an owner and a
 * `name/extra` that names nothing.
 */
export function splitRepo(repo: string): { owner: string; name: string } {
  if (!isValidRepo(repo)) {
    throw new Error(`not owner/name: ${JSON.stringify(repo)}`);
  }
  const slash = repo.indexOf("/");
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
}
