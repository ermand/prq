import { afterEach, describe, expect, test } from "bun:test";
import { parseArgs, performSync } from "./cli";
import { normalize, type PullRequest, type RawPullRequest } from "./domain";
import { Store } from "./store";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GITHUB_TOKEN;
});

function rawPr(over: Partial<RawPullRequest> = {}): RawPullRequest {
  return {
    id: "PR_1",
    number: 1,
    title: "A change",
    url: "https://github.com/org/repo/pull/1",
    isDraft: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    headRefOid: "0".repeat(40),
    baseRefName: "main",
    mergeable: "MERGEABLE",
    reviewDecision: "REVIEW_REQUIRED",
    author: { login: "alice" },
    repository: { nameWithOwner: "org/repo" },
    viewerDidAuthor: false,
    viewerLatestReview: null,
    viewerLatestReviewRequest: null,
    latestOpinionatedReviews: { nodes: [] },
    stack: null,
    stackEntry: null,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    ...over,
  };
}

/** Answers both halves of the scan with the given nodes, or fails one of them. */
function stub(pages: Array<{ nodes: RawPullRequest[]; fail?: boolean }>): void {
  let call = 0;
  globalThis.fetch = (async () => {
    const page = pages[Math.min(call++, pages.length - 1)]!;
    if (page.fail) return new Response("<html>502</html>", { status: 502 });
    return new Response(
      JSON.stringify({
        data: {
          rateLimit: { cost: 1, remaining: 4999 },
          viewer: { login: "ermand" },
          search: {
            issueCount: page.nodes.length,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: page.nodes,
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

const mem = () => Store.open(":memory:");
const repos = ["org/repo"];

describe("performSync", () => {
  test("a first sync commits a baseline and reports nothing", async () => {
    process.env.GITHUB_TOKEN = "t";
    const store = await mem();
    stub([{ nodes: [rawPr()] }]);
    const outcome = await performSync(store, repos);
    expect(outcome.baselineReset).toBe(true);
    expect(outcome.changes).toEqual([]);
    expect(outcome.sync).not.toBeNull();
    expect(store.read().prs).toHaveLength(1);
    store.close();
  });

  test("the second sync reports a real change", async () => {
    process.env.GITHUB_TOKEN = "t";
    const store = await mem();
    stub([{ nodes: [rawPr()] }]);
    await performSync(store, repos);
    stub([{ nodes: [rawPr({ baseRefName: "release" })] }]);
    const outcome = await performSync(store, repos);
    expect(outcome.baselineReset).toBe(false);
    expect(outcome.changes.map((c) => c.kind)).toContain("retargeted");
    store.close();
  });

  test("an empty first sync does not swallow the first PR to appear", async () => {
    // A previous sync that legitimately stored zero PRs is not a reset. Treating
    // it as one lost the `joined` event permanently: the sync after had the PR in
    // its baseline, so nothing ever reported it.
    process.env.GITHUB_TOKEN = "t";
    const store = await mem();
    stub([{ nodes: [] }]);
    const first = await performSync(store, repos);
    expect(first.baselineReset).toBe(true);

    stub([{ nodes: [rawPr()] }]);
    const second = await performSync(store, repos);
    expect(second.baselineReset).toBe(false);
    expect(second.changes.map((c) => c.kind)).toEqual(["joined"]);
    store.close();
  });

  test("a partial scan is not committed and reports no changes", async () => {
    // The union is two searches. If one fails, every PR only it returns looks
    // departed — so the report would claim a dozen PRs left the set.
    process.env.GITHUB_TOKEN = "t";
    const store = await mem();
    stub([{ nodes: [rawPr({ id: "A" }), rawPr({ id: "B", number: 2 })] }]);
    await performSync(store, repos);
    const committed = store.lastSync()!;

    // First half fails; second half returns only one of the two PRs.
    let call = 0;
    globalThis.fetch = (async () => {
      if (call++ === 0) return new Response("<html>502</html>", { status: 502 });
      return new Response(
        JSON.stringify({
          data: {
            rateLimit: { cost: 1, remaining: 4999 },
            viewer: { login: "ermand" },
            search: {
              issueCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [rawPr({ id: "A" })],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const outcome = await performSync(store, repos);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.sync).toBeNull();
    expect(outcome.changes).toEqual([]);
    // The baseline is untouched: same sync id, both PRs still stored.
    expect(store.lastSync()!.id).toBe(committed.id);
    expect(store.read().prs).toHaveLength(2);
    store.close();
  });

  test("a partial scan keeps the old age rather than reading as just now", async () => {
    // Otherwise the header claims fresh data over an hours-old baseline, the
    // precise confusion the status line exists to prevent. Compared against the
    // stored timestamp exactly, so this does not depend on the clock advancing.
    process.env.GITHUB_TOKEN = "t";
    const store = await mem();
    stub([{ nodes: [rawPr()] }]);
    await performSync(store, repos);
    const committedAt = store.lastSync()!.at;

    // Only the first half fails, so the scan is partial rather than a total
    // failure — a total one throws instead of returning an outcome.
    stub([{ nodes: [], fail: true }, { nodes: [rawPr()] }]);
    const outcome = await performSync(store, repos);
    expect(outcome.failures.length).toBeGreaterThan(0);
    expect(outcome.at.toISOString()).toBe(committedAt);
    store.close();
  });

  test("a shortfall against the stored count resets the baseline", async () => {
    // Rows lost to validation would otherwise be reported as `left` and then
    // re-reported as `joined`, both fabricated.
    process.env.GITHUB_TOKEN = "t";
    const store = await mem();
    stub([{ nodes: [rawPr({ id: "A" }), rawPr({ id: "B", number: 2 })] }]);
    await performSync(store, repos);
    // @ts-expect-error — reaching the private handle to simulate tampering.
    store.db.query("UPDATE pr SET payload = ? WHERE id = ?").run("{ broken", "B");

    stub([{ nodes: [rawPr({ id: "A" }), rawPr({ id: "B", number: 2 })] }]);
    const outcome = await performSync(store, repos);
    expect(outcome.baselineReset).toBe(true);
    expect(outcome.changes).toEqual([]);
    store.close();
  });
});

describe("parseArgs", () => {
  test("finds the subcommand before a flag", () => {
    expect(parseArgs(["sync"]).command).toBe("sync");
    expect(parseArgs(["init"]).command).toBe("init");
  });

  test("finds the subcommand after a flag and its value", () => {
    // Read positionally, `--state x sync` silently opened the dashboard.
    expect(parseArgs(["--state", "/tmp/a.db", "sync"])).toEqual({
      command: "sync",
      statePath: "/tmp/a.db",
    });
  });

  test("finds a flag after the subcommand too", () => {
    expect(parseArgs(["sync", "--state", "/tmp/a.db"])).toEqual({
      command: "sync",
      statePath: "/tmp/a.db",
    });
  });

  test("no subcommand means the dashboard", () => {
    expect(parseArgs([]).command).toBeUndefined();
    expect(parseArgs(["--state", "/tmp/a.db"]).command).toBeUndefined();
  });

  test("never mistakes the flag's value for the subcommand", () => {
    expect(parseArgs(["--state", "sync"]).command).toBeUndefined();
    expect(parseArgs(["--state", "sync"]).statePath).toBe("sync");
  });

  test("rejects a missing or flag-shaped path", () => {
    expect(() => parseArgs(["--state"])).toThrow(/needs a path/);
    expect(() => parseArgs(["--state", "--help"])).toThrow(/needs a path/);
  });

  test("ignores unrelated flags", () => {
    expect(parseArgs(["--json", "sync"]).command).toBe("sync");
  });
});
