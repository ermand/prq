import { afterEach, describe, expect, test } from "bun:test";
import { scan } from "./github";

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
              headRefOid: "h",
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
                  headRefOid: "h",
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
