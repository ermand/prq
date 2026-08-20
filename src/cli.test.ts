import { afterEach, describe, expect, test } from "bun:test";
import { parseArgs } from "./cli";
import {
  oldestSync,
  performSync,
  readAll,
  syncProvider,
  viewersOf,
  type ProviderOutcome,
} from "./engine";
import type { Provider, RawPullRequest } from "./domain";
import { Store } from "./store";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITLAB_TOKEN;
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

/** Answers GitHub's two search halves with the given nodes, or fails one. */
function stubGitHub(pages: Array<{ nodes: RawPullRequest[]; fail?: boolean }>): void {
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
const both = (github: string[] = [], gitlab: string[] = []): Record<Provider, string[]> => ({
  github,
  gitlab,
});

describe("syncProvider", () => {
  test("a first sync commits a baseline and reports nothing", async () => {
    process.env.GITHUB_TOKEN = "t";
    const store = await mem();
    stubGitHub([{ nodes: [rawPr()] }]);
    const outcome = await syncProvider(store, "github", repos);
    expect(outcome.baselineReset).toBe(true);
    expect(outcome.changes).toEqual([]);
    expect(outcome.sync).not.toBeNull();
    expect(store.read("github").prs).toHaveLength(1);
    store.close();
  });

  test("the second sync reports a real change", async () => {
    process.env.GITHUB_TOKEN = "t";
    const store = await mem();
    stubGitHub([{ nodes: [rawPr()] }]);
    await syncProvider(store, "github", repos);
    stubGitHub([{ nodes: [rawPr({ baseRefName: "release" })] }]);
    const outcome = await syncProvider(store, "github", repos);
    expect(outcome.baselineReset).toBe(false);
    expect(outcome.changes.map((c) => c.kind)).toContain("retargeted");
    store.close();
  });

  test("an empty first sync does not swallow the first PR to appear", async () => {
    process.env.GITHUB_TOKEN = "t";
    const store = await mem();
    stubGitHub([{ nodes: [] }]);
    expect((await syncProvider(store, "github", repos)).baselineReset).toBe(true);
    stubGitHub([{ nodes: [rawPr()] }]);
    const second = await syncProvider(store, "github", repos);
    expect(second.baselineReset).toBe(false);
    expect(second.changes.map((c) => c.kind)).toEqual(["joined"]);
    store.close();
  });

  test("a partial scan is not committed and reports no changes", async () => {
    process.env.GITHUB_TOKEN = "t";
    const store = await mem();
    stubGitHub([{ nodes: [rawPr({ id: "A" }), rawPr({ id: "B", number: 2 })] }]);
    await syncProvider(store, "github", repos);
    const committed = store.lastSync("github")!;

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

    const outcome = await syncProvider(store, "github", repos);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.sync?.id).toBe(committed.id);
    expect(outcome.changes).toEqual([]);
    expect(store.read("github").prs).toHaveLength(2);
    // The previous rows stay on screen. Showing only the half the scan did see
    // would read as "everything else was merged" — and the caller cannot tell the
    // difference, because a partial scan is exactly when it must not.
    expect(outcome.prs.map((p) => p.id).sort()).toEqual(["A", "B"]);
    store.close();
  });

  test("a provider with no configured projects is neither scanned nor failed", async () => {
    // Not the same as a provider that returned nothing: no request is made.
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const store = await mem();
    const outcome = await syncProvider(store, "gitlab", []);
    expect(called).toBe(false);
    expect(outcome.failures).toEqual([]);
    expect(outcome.prs).toEqual([]);
    expect(store.syncCount("gitlab")).toBe(0);
    store.close();
  });
});

describe("per-provider baselines", () => {
  test("one provider failing leaves the other's baseline intact", async () => {
    // The whole reason for per-provider baselines: an expired GitLab token must
    // not freeze the memory of a much larger GitHub board.
    process.env.GITHUB_TOKEN = "t";
    process.env.GITLAB_TOKEN = "t";
    const store = await mem();

    let call = 0;
    globalThis.fetch = (async (url: string | URL) => {
      const target = String(url);
      if (target.includes("gitlab.com")) {
        return new Response("<html>500</html>", { status: 500 });
      }
      call++;
      return new Response(
        JSON.stringify({
          data: {
            rateLimit: { cost: 1, remaining: 10 },
            viewer: { login: "ermand" },
            search: {
              issueCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [rawPr()],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const outcome = await performSync(store, both(repos, ["group/sub/proj"]));
    const gh = outcome.byProvider.find((p) => p.provider === "github")!;
    const gl = outcome.byProvider.find((p) => p.provider === "gitlab")!;

    expect(gh.failures).toEqual([]);
    expect(gh.sync).not.toBeNull();
    expect(store.read("github").prs).toHaveLength(1);

    expect(gl.failures).toHaveLength(1);
    expect(store.syncCount("gitlab")).toBe(0);
    // And the union still carries the healthy half.
    expect(outcome.prs).toHaveLength(1);
    expect(outcome.failures).toHaveLength(1);
    store.close();
  });

  test("a provider's rows survive its own failure", async () => {
    process.env.GITHUB_TOKEN = "t";
    const store = await mem();
    stubGitHub([{ nodes: [rawPr({ title: "still here" })] }]);
    await syncProvider(store, "github", repos);

    globalThis.fetch = (async () =>
      new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch;
    const outcome = await performSync(store, both(repos));
    const gh = outcome.byProvider.find((p) => p.provider === "github")!;
    // Dropping them would read as "everything there was merged".
    expect(gh.prs.map((p) => p.title)).toEqual(["still here"]);
    expect(gh.failures.length).toBeGreaterThan(0);
    store.close();
  });
});

describe("readAll", () => {
  test("reads both providers with no network call", async () => {
    process.env.GITHUB_TOKEN = "t";
    const store = await mem();
    stubGitHub([{ nodes: [rawPr()] }]);
    await syncProvider(store, "github", repos);

    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const state = readAll(store);
    expect(called).toBe(false);
    expect(state.prs).toHaveLength(1);
    expect(state.byProvider.map((p) => p.provider)).toEqual(["github", "gitlab"]);
    store.close();
  });
});

describe("oldestSync", () => {
  const at = (iso: string): ProviderOutcome => ({
    provider: "github",
    sync: null,
    prs: [],
    changes: [],
    failures: [],
    baselineReset: false,
    at: new Date(iso),
    viewer: "x",
  });

  test("shows the oldest baseline, never the newest", () => {
    // A fresh half must not hide a stale one.
    const stale = { ...at("2026-01-01T00:00:00Z"), sync: {} as never };
    const fresh = { ...at("2026-06-01T00:00:00Z"), sync: {} as never };
    expect(oldestSync([fresh, stale])?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  test("ignores a provider that has never synced and has no rows", () => {
    const synced = { ...at("2026-06-01T00:00:00Z"), sync: {} as never };
    const never = { ...at("2026-01-01T00:00:00Z"), at: null, sync: null };
    expect(oldestSync([synced, never])?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  test("is null when nothing has synced", () => {
    expect(oldestSync([{ ...at("2026-01-01T00:00:00Z"), at: null }])).toBeNull();
  });
});

describe("viewersOf", () => {
  test("lists each provider's identity once", () => {
    // Two providers means two accounts: ermand on GitHub, ermandduro on GitLab.
    const base: ProviderOutcome = {
      provider: "github",
      sync: null,
      prs: [],
      changes: [],
      failures: [],
      baselineReset: false,
      at: null,
      viewer: "",
    };
    expect(
      viewersOf([
        { ...base, viewer: "ermand" },
        { ...base, provider: "gitlab", viewer: "ermandduro" },
      ]),
    ).toBe("ermand · ermandduro");
    expect(viewersOf([{ ...base, viewer: "same" }, { ...base, viewer: "same" }])).toBe("same");
    expect(viewersOf([base])).toBe("");
  });
});

describe("parseArgs", () => {
  test("finds the subcommand before a flag", () => {
    expect(parseArgs(["sync"]).command).toBe("sync");
    expect(parseArgs(["init"]).command).toBe("init");
  });

  test("finds the subcommand after a flag and its value", () => {
    expect(parseArgs(["--state", "/tmp/a.db", "sync"])).toEqual({
      command: "sync",
      statePath: "/tmp/a.db",
      port: undefined,
      open: true,
    });
  });

  test("finds a flag after the subcommand too", () => {
    expect(parseArgs(["sync", "--state", "/tmp/a.db"])).toEqual({
      command: "sync",
      statePath: "/tmp/a.db",
      port: undefined,
      open: true,
    });
  });

  test("reads the web port", () => {
    expect(parseArgs(["web", "--port", "3000"]).port).toBe(3000);
    expect(parseArgs(["web"]).port).toBeUndefined();
  });

  test("refuses a port that is not a number, rather than coercing it", () => {
    // `--port abc` silently becoming NaN and falling back to the default is a
    // worse outcome than refusing to start.
    expect(() => parseArgs(["web", "--port", "abc"])).toThrow("--port needs a number");
    expect(() => parseArgs(["web", "--port"])).toThrow("--port needs a number");
  });

  test("refuses a port outside the valid range", () => {
    expect(() => parseArgs(["web", "--port", "0"])).toThrow("--port is out of range");
    expect(() => parseArgs(["web", "--port", "70000"])).toThrow(
      "--port is out of range",
    );
  });

  test("--no-open suppresses the browser, and is on by default", () => {
    expect(parseArgs(["web"]).open).toBe(true);
    expect(parseArgs(["web", "--no-open"]).open).toBe(false);
  });

  test("never mistakes the port value for the subcommand", () => {
    expect(parseArgs(["--port", "4177", "web"]).command).toBe("web");
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
});
