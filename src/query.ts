/**
 * GraphQL for the scan.
 *
 * A scan is two searches, not a walk over the repository list — see wayfinder
 * ticket 0013. `involves:` covers author, assignee, mentions and commenter but
 * *excludes* review requests, so the queue needs its own query; search
 * qualifiers are ANDed with no way to OR them.
 */

/** Every field the domain model needs, in one round trip. */
export const PR_FIELDS = `
  id number title url isDraft createdAt updatedAt headRefOid
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
