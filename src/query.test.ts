import { describe, expect, test } from "bun:test";
import {
  buildSearchQuery,
  isValidRepo,
  PR_FIELDS,
  SCAN_FILTERS,
  SCAN_QUERY,
} from "./query";

describe("buildSearchQuery", () => {
  test("scopes every repo and keeps the filter", () => {
    const q = buildSearchQuery(["o/a", "o/b"], "review-requested:@me");
    expect(q).toBe("is:pr is:open repo:o/a repo:o/b review-requested:@me");
  });

  test("refuses an empty repo list rather than searching all of GitHub", () => {
    // Without repo: qualifiers the query would match the entire site.
    expect(() => buildSearchQuery([], "involves:@me")).toThrow(/no repositories/);
  });

  test("always constrains to open pull requests", () => {
    for (const filter of SCAN_FILTERS) {
      expect(buildSearchQuery(["o/a"], filter)).toStartWith("is:pr is:open ");
    }
  });
});

describe("scan filters", () => {
  test("the queue has its own query because involves excludes it", () => {
    // Measured: involves:@me missed 27 of 32 review requests for one user.
    // Qualifiers are ANDed, so one query cannot cover both.
    expect(SCAN_FILTERS).toEqual(["review-requested:@me", "involves:@me"]);
  });
});

describe("SCAN_QUERY", () => {
  test("selects the fields the domain model reads", () => {
    for (const field of [
      "viewerDidAuthor",
      "viewerLatestReview",
      "viewerLatestReviewRequest",
      "latestOpinionatedReviews",
      "statusCheckRollup",
      "stackEntry",
      "headRefOid",
    ]) {
      expect(PR_FIELDS).toInclude(field);
    }
  });

  test("does not select mergeStateStatus", () => {
    // It doubles query latency and adds nothing over mergeable + rollup.
    expect(PR_FIELDS).not.toInclude("mergeStateStatus");
  });

  test("exposes paging and identity", () => {
    expect(SCAN_QUERY).toInclude("hasNextPage");
    expect(SCAN_QUERY).toInclude("endCursor");
    expect(SCAN_QUERY).toInclude("viewer { login }");
  });
});

describe("isValidRepo", () => {
  test("accepts owner/name and rejects anything else", () => {
    expect(isValidRepo("cli/cli")).toBe(true);
    expect(isValidRepo("my-org/my.repo_1")).toBe(true);
    expect(isValidRepo("cli")).toBe(false);
    expect(isValidRepo("a/b/c")).toBe(false);
    expect(isValidRepo("https://github.com/cli/cli")).toBe(false);
    expect(isValidRepo("cli/cli is:private")).toBe(false);
    expect(isValidRepo("")).toBe(false);
  });
});
