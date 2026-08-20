import { afterEach, describe, expect, test } from "bun:test";
import { MAX_PAGES } from "./census";
import { githubCensus, readRepoCensus, scan } from "./github";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface PageSpec {
  nodes?: number;
  hasNextPage?: boolean;
  endCursor?: string | null;
  issueCount?: number;
  remaining?: number;
}

let nodeSeq = 0;

function stubFetch(page: (call: number) => PageSpec | Response): () => number {
  let calls = 0;
  globalThis.fetch = (async () => {
    const spec = page(calls++);
    if (spec instanceof Response) return spec;
    const {
      nodes = 1,
      hasNextPage = false,
      endCursor = "cursor",
      issueCount = nodes,
      remaining = 4999,
    } = spec;
    return new Response(
      JSON.stringify({
        data: {
          rateLimit: { cost: 1, remaining },
          viewer: { login: "ermand" },
          search: {
            issueCount,
            pageInfo: { hasNextPage, endCursor },
            nodes: Array.from({ length: nodes }, () => ({
              id: `PR_${nodeSeq++}`,
              number: 1,
              title: "t",
              url: "https://github.com/o/r/pull/1",
              isDraft: false,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              headRefOid: "0".repeat(40),
              baseRefName: "main",
              mergeable: "MERGEABLE",
              reviewDecision: "REVIEW_REQUIRED",
              author: { login: "a" },
              repository: { nameWithOwner: "o/r" },
              viewerDidAuthor: false,
              viewerLatestReview: null,
              viewerLatestReviewRequest: null,
              latestOpinionatedReviews: { nodes: [] },
              stack: null,
              stackEntry: null,
              commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
            })),
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return () => calls;
}

describe("paging", () => {
  test("a null cursor ends the loop instead of refetching page one forever", async () => {
    // hasNextPage true with endCursor null would send `after` back to null.
    const calls = stubFetch(() => ({ hasNextPage: true, endCursor: null }));
    await scan(["o/r"], "token");
    // Two filters, one request each — not ten each.
    expect(calls()).toBe(2);
  });

  test("hitting the page cap is reported as a failure, not silently clipped", async () => {
    stubFetch(() => ({ nodes: 100, hasNextPage: true, endCursor: "c", issueCount: 5000 }));
    const result = await scan(["o/r"], "token");
    expect(result.failures).toHaveLength(2);
    for (const failure of result.failures) expect(failure).toInclude("truncated");
    expect(result.failures[0]).toInclude("5000");
  });

  test("a complete scan reports no failures", async () => {
    stubFetch(() => ({ nodes: 2, hasNextPage: false }));
    const result = await scan(["o/r"], "token");
    expect(result.failures).toEqual([]);
  });
});

describe("rate limit accounting", () => {
  test("keeps the smallest remaining, including zero", async () => {
    // `||` would discard the zero — the one value that matters.
    let call = 0;
    stubFetch(() => ({ remaining: call++ === 0 ? 4321 : 0 }));
    const result = await scan(["o/r"], "token");
    expect(result.remaining).toBe(0);
  });
});

describe("failure handling", () => {
  test("a 502 HTML body is reported as a budget failure, not a parse crash", async () => {
    stubFetch(() => new Response("<html>502</html>", { status: 502 }));
    await expect(scan(["o/r"], "token")).rejects.toThrow(/execution budget/);
  });

  test("HTTP 200 carrying errors[] does not render as success", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ data: null, errors: [{ type: "RESOURCE_LIMITS_EXCEEDED" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await expect(scan(["o/r"], "token")).rejects.toThrow(/RESOURCE_LIMITS_EXCEEDED/);
  });

  test("one filter failing still returns the other half, marked incomplete", async () => {
    let call = 0;
    stubFetch(() => (call++ === 0 ? new Response("<html>", { status: 502 }) : { nodes: 3 }));
    const result = await scan(["o/r"], "token");
    expect(result.prs).toHaveLength(3);
    expect(result.failures).toHaveLength(1);
  });

  test("control characters in a server error message are stripped", async () => {
    // The message reaches the terminal; a newline in it breaks the viewport.
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ errors: [{ message: "bad\n\u001b]52;c;evil\u0007thing" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await expect(scan(["o/r"], "token")).rejects.toThrow();
    let call = 0;
    stubFetch(() =>
      call++ === 0
        ? new Response(JSON.stringify({ errors: [{ message: "bad\nnewline" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : { nodes: 1 },
    );
    const result = await scan(["o/r"], "token");
    expect(result.failures[0]).not.toInclude("\n");
  });
});

describe("the union", () => {
  test("a PR matching both filters appears once", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            rateLimit: { cost: 1, remaining: 10 },
            viewer: { login: "ermand" },
            search: {
              issueCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "SAME_ID",
                  number: 1,
                  title: "t",
                  url: "https://github.com/o/r/pull/1",
                  isDraft: false,
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-01T00:00:00Z",
                  headRefOid: "0".repeat(40),
                  baseRefName: "main",
                  mergeable: "MERGEABLE",
                  reviewDecision: "REVIEW_REQUIRED",
                  author: { login: "a" },
                  repository: { nameWithOwner: "o/r" },
                  viewerDidAuthor: false,
                  viewerLatestReview: null,
                  viewerLatestReviewRequest: null,
                  latestOpinionatedReviews: { nodes: [] },
                  stack: null,
                  stackEntry: null,
                  commits: {
                    nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }],
                  },
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const result = await scan(["o/r"], "token");
    expect(result.prs).toHaveLength(1);
  });
});

/** A census node with every field the mapper reads, overridable per test. */
function censusNode(over: Record<string, unknown> = {}) {
  return {
    number: 1,
    title: "t",
    url: "https://github.com/o/r/pull/1",
    state: "OPEN",
    isDraft: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    mergedAt: null,
    closedAt: null,
    additions: 3,
    deletions: 1,
    changedFiles: 2,
    author: { login: "a" },
    mergedBy: null,
    reviews: { nodes: [] },
    ...over,
  };
}

interface CensusPageSpec {
  nodes?: unknown[];
  hasNextPage?: boolean;
  endCursor?: string | null;
}

function stubCensus(page: (call: number) => CensusPageSpec | Response): () => number {
  let calls = 0;
  globalThis.fetch = (async () => {
    const spec = page(calls++);
    if (spec instanceof Response) return spec;
    const { nodes = [censusNode()], hasNextPage = false, endCursor = "cursor" } = spec;
    return new Response(
      JSON.stringify({
        data: {
          rateLimit: { cost: 1, remaining: 4999 },
          repository: {
            pullRequests: {
              totalCount: nodes.length,
              pageInfo: { hasNextPage, endCursor },
              nodes,
            },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return () => calls;
}

describe("census paging", () => {
  test("pages are stitched in the order the connection returned them", async () => {
    const pages = [[1, 2], [3], [4, 5]];
    const calls = stubCensus((call) => ({
      nodes: (pages[call] ?? []).map((number) => censusNode({ number })),
      hasNextPage: call < pages.length - 1,
      endCursor: `c${call}`,
    }));
    const census = await readRepoCensus("o/r", "token", null);
    expect(calls()).toBe(3);
    expect(census.prs.map((pr) => pr.number)).toEqual([1, 2, 3, 4, 5]);
    expect(census.failed).toBeNull();
    expect(census.truncated).toBe(false);
    expect(census.reviewPrecision).toBe("exact");
  });

  test("a null cursor ends the walk instead of refetching page one forever", async () => {
    const calls = stubCensus(() => ({ hasNextPage: true, endCursor: null }));
    const census = await readRepoCensus("o/r", "token", null);
    expect(calls()).toBe(1);
    expect(census.truncated).toBe(false);
  });

  test("the page ceiling is reported as truncation, never as a whole history", async () => {
    const calls = stubCensus((call) => ({
      nodes: [censusNode({ number: call + 1 })],
      hasNextPage: true,
      endCursor: `c${call}`,
    }));
    const census = await readRepoCensus("o/r", "token", null);
    expect(calls()).toBe(MAX_PAGES);
    expect(census.prs).toHaveLength(MAX_PAGES);
    expect(census.truncated).toBe(true);
    // Truncation is not a failure: the rows fetched are real.
    expect(census.failed).toBeNull();
  });
});

describe("census watermark", () => {
  test("the first row older than `since` ends the walk and is dropped", async () => {
    const calls = stubCensus(() => ({
      nodes: [
        censusNode({ number: 9, updatedAt: "2026-05-02T00:00:00Z" }),
        censusNode({ number: 8, updatedAt: "2026-05-01T00:00:00Z" }),
        censusNode({ number: 7, updatedAt: "2026-03-01T00:00:00Z" }),
        censusNode({ number: 6, updatedAt: "2026-02-01T00:00:00Z" }),
      ],
      hasNextPage: true,
      endCursor: "c",
    }));
    const census = await readRepoCensus("o/r", "token", "2026-04-01T00:00:00Z");
    expect(census.prs.map((pr) => pr.number)).toEqual([9, 8]);
    // Stopping mid-page must also stop the walk — hasNextPage was still true.
    expect(calls()).toBe(1);
    expect(census.truncated).toBe(false);
  });

  test("an offset-bearing watermark compares by instant, not by digits", async () => {
    // 02:00+02:00 is midnight UTC; the row an hour before it must be dropped
    // even though "2026-03-31..." sorts below "2026-04-01..." either way, and
    // the row an hour after it must survive.
    stubCensus(() => ({
      nodes: [
        censusNode({ number: 2, updatedAt: "2026-04-01T01:00:00Z" }),
        censusNode({ number: 1, updatedAt: "2026-03-31T23:00:00Z" }),
      ],
    }));
    const census = await readRepoCensus("o/r", "token", "2026-04-01T02:00:00+02:00");
    expect(census.prs.map((pr) => pr.number)).toEqual([2]);
  });

  test("a null watermark walks the whole connection", async () => {
    stubCensus(() => ({
      nodes: [
        censusNode({ number: 2, updatedAt: "2026-05-01T00:00:00Z" }),
        censusNode({ number: 1, updatedAt: "2019-01-01T00:00:00Z" }),
      ],
    }));
    const census = await readRepoCensus("o/r", "token", null);
    expect(census.prs).toHaveLength(2);
  });
});

describe("census failure handling", () => {
  test("a GraphQL errors[] payload fails the repo instead of throwing", async () => {
    stubCensus(
      () =>
        new Response(
          JSON.stringify({ data: null, errors: [{ type: "RATE_LIMITED" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const census = await readRepoCensus("o/r", "token", null);
    expect(census.failed).toInclude("RATE_LIMITED");
    expect(census.prs).toEqual([]);
    expect(census.reviews).toEqual([]);
    expect(census.truncated).toBe(false);
  });

  test("a null repository is a failure, not an empty repo", async () => {
    // HTTP 200 with `repository: null` — renamed, private or deleted.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ data: { rateLimit: { cost: 1, remaining: 4999 }, repository: null } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const census = await readRepoCensus("o/r", "token", null);
    expect(census.failed).toInclude("no repository");
    expect(census.failed).toInclude("o/r");
    expect(census.prs).toEqual([]);
  });

  test("a mid-walk failure discards the pages already fetched", async () => {
    // A prefix dressed as a whole history would be written over real rows.
    stubCensus((call) =>
      call === 0
        ? { nodes: [censusNode({ number: 1 })], hasNextPage: true, endCursor: "c" }
        : new Response("<html>502</html>", { status: 502 }),
    );
    const census = await readRepoCensus("o/r", "token", null);
    expect(census.prs).toEqual([]);
    expect(census.failed).toInclude("execution budget");
  });

  test("control characters in a census failure are stripped", async () => {
    stubCensus(
      () =>
        new Response(JSON.stringify({ errors: [{ message: "bad\nthing\u0007" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const census = await readRepoCensus("o/r", "token", null);
    expect(census.failed).not.toInclude("\n");
    expect(census.failed).not.toInclude("\u0007");
  });

  test("an aborted signal stops the walk without a request", async () => {
    const calls = stubCensus(() => ({}));
    const census = await readRepoCensus("o/r", "token", null, AbortSignal.abort());
    expect(calls()).toBe(0);
    expect(census.prs).toEqual([]);
    expect(census.failed).not.toBeNull();
  });

  test("a repo that is not owner/name is refused before any spawn or request", async () => {
    const saved = { github: process.env.GITHUB_TOKEN, gh: process.env.GH_TOKEN };
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    const calls = stubCensus(() => ({}));
    try {
      const census = await githubCensus.censusRepo("o/r/extra", null);
      // A `gh auth token` spawn would have failed with a token message instead,
      // and a resolved token would have reached the stub.
      expect(census.failed).toInclude("not owner/name");
      expect(calls()).toBe(0);
      expect(census.prs).toEqual([]);
    } finally {
      if (saved.github === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = saved.github;
      if (saved.gh === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = saved.gh;
    }
  });

  test("the census seam resolves a token from the environment and walks", async () => {
    const saved = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "env-token";
    try {
      stubCensus(() => ({ nodes: [censusNode({ number: 42 })] }));
      const census = await githubCensus.censusRepo("o/r", null);
      expect(census.provider).toBe("github");
      expect(census.prs.map((pr) => pr.number)).toEqual([42]);
    } finally {
      if (saved === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = saved;
    }
  });
});

describe("census mapping", () => {
  test("a hidden author becomes an empty login rather than a crash", async () => {
    stubCensus(() => ({ nodes: [censusNode({ author: null, number: 5 })] }));
    const census = await readRepoCensus("o/r", "token", null);
    expect(census.prs[0]?.author).toBe("");
    expect(census.prs[0]?.number).toBe(5);
  });

  test("states, drafts, diffs and timestamps map onto the contract", async () => {
    stubCensus(() => ({
      nodes: [
        censusNode({
          number: 2,
          state: "MERGED",
          isDraft: true,
          title: "ship\nit",
          mergedAt: "2026-04-02T10:00:00+02:00",
          closedAt: "2026-04-02T08:00:00Z",
          additions: 10,
          deletions: -1,
          changedFiles: 4,
          mergedBy: { login: "m" },
        }),
        censusNode({ number: 3, state: "CLOSED", mergedBy: { login: "ghost" } }),
      ],
    }));
    const census = await readRepoCensus("o/r", "token", null);
    const [merged, closed] = census.prs;
    expect(merged?.state).toBe("merged");
    expect(merged?.draft).toBe(true);
    // Sanitised: a newline in a title breaks the viewport.
    expect(merged?.title).toBe("ship it");
    // Canonical UTC, so string ordering downstream is chronological.
    expect(merged?.mergedAt).toBe("2026-04-02T08:00:00.000Z");
    expect(merged?.closedAt).toBe("2026-04-02T08:00:00.000Z");
    expect(merged?.additions).toBe(10);
    // A negative diff stat is not evidence of deletions.
    expect(merged?.deletions).toBe(0);
    expect(merged?.files).toBe(4);
    expect(merged?.mergedBy).toBe("m");
    expect(closed?.state).toBe("closed");
    // Empty unless merged, whatever the API attached.
    expect(closed?.mergedBy).toBe("");
    expect(closed?.mergedAt).toBeNull();
  });

  test("a non-https url is dropped rather than carried to a click", async () => {
    stubCensus(() => ({ nodes: [censusNode({ url: "javascript:alert(1)" })] }));
    const census = await readRepoCensus("o/r", "token", null);
    expect(census.prs[0]?.url).toBeNull();
  });

  test("PENDING reviews are dropped and the rest map to acts", async () => {
    stubCensus(() => ({
      nodes: [
        censusNode({
          number: 7,
          reviews: {
            nodes: [
              { state: "APPROVED", submittedAt: "2026-01-02T00:00:00Z", author: { login: "a" } },
              {
                state: "CHANGES_REQUESTED",
                submittedAt: "2026-01-03T00:00:00Z",
                author: { login: "b" },
              },
              { state: "COMMENTED", submittedAt: "2026-01-04T00:00:00Z", author: { login: "c" } },
              { state: "DISMISSED", submittedAt: "2026-01-05T00:00:00Z", author: { login: "d" } },
              // An unsubmitted draft review: nobody has received it.
              { state: "PENDING", submittedAt: null, author: { login: "e" } },
              null,
            ],
          },
        }),
      ],
    }));
    const census = await readRepoCensus("o/r", "token", null);
    expect(census.reviews.map((review) => review.act)).toEqual([
      "approved",
      "changes-requested",
      "commented",
      "dismissed",
    ]);
    expect(census.reviews.map((review) => review.reviewer)).toEqual(["a", "b", "c", "d"]);
    // GitHub timestamps reviews, which is what makes latency computable here.
    expect(census.reviews[0]?.at).toBe("2026-01-02T00:00:00.000Z");
    expect(census.reviews.every((review) => review.number === 7)).toBe(true);
    expect(census.reviews.every((review) => review.repo === "o/r")).toBe(true);
    expect(census.reviewPrecision).toBe("exact");
  });

  test("reviews from dropped rows do not leak past the watermark", async () => {
    stubCensus(() => ({
      nodes: [
        censusNode({
          number: 2,
          updatedAt: "2026-05-01T00:00:00Z",
          reviews: {
            nodes: [{ state: "APPROVED", submittedAt: "2026-05-01T00:00:00Z", author: { login: "a" } }],
          },
        }),
        censusNode({
          number: 1,
          updatedAt: "2026-01-01T00:00:00Z",
          reviews: {
            nodes: [{ state: "APPROVED", submittedAt: "2026-01-01T00:00:00Z", author: { login: "b" } }],
          },
        }),
      ],
    }));
    const census = await readRepoCensus("o/r", "token", "2026-04-01T00:00:00Z");
    expect(census.reviews.map((review) => review.reviewer)).toEqual(["a"]);
  });
});