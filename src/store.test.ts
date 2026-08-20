import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { diff } from "./changes";
import { normalize, type PullRequest, type RawPullRequest } from "./domain";
import type { CensusPr, CensusReview, RepoCensus } from "./census";
import { resolveStorePath, SCHEMA_VERSION, Store, storePath } from "./store";

const AT = new Date("2026-06-01T00:00:00.000Z");

function censusPr(over: Partial<CensusPr> = {}): CensusPr {
  return {
    provider: "github",
    repo: "org/repo",
    number: 1,
    state: "merged",
    draft: false,
    title: "A change",
    url: "https://github.com/org/repo/pull/1",
    author: "alice",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-05T00:00:00.000Z",
    mergedAt: "2026-01-05T00:00:00.000Z",
    closedAt: null,
    additions: 10,
    deletions: 2,
    files: 3,
    mergedBy: "bob",
    ...over,
  };
}

function censusReview(over: Partial<CensusReview> = {}): CensusReview {
  return {
    provider: "github",
    repo: "org/repo",
    number: 1,
    reviewer: "bob",
    act: "approved",
    at: "2026-01-04T00:00:00.000Z",
    ...over,
  };
}

function census(over: Partial<RepoCensus> = {}): RepoCensus {
  return {
    provider: "github",
    repo: "org/repo",
    prs: [censusPr()],
    reviews: [censusReview()],
    reviewPrecision: "exact",
    failed: null,
    truncated: false,
    ...over,
  };
}

function pr(over: Partial<PullRequest> = {}): PullRequest {
  const base = normalize(
    {
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
    } satisfies RawPullRequest,
    "ermand",
  );
  return { ...base, ...over };
}

const mem = () => Store.open(":memory:");

const commit = (store: Store, prs: PullRequest[], previous: PullRequest[] = []) =>
  store.commit({
    provider: "github",
    viewer: "ermand",
    repos: ["org/repo"],
    prs,
    changes: diff(previous, prs),
    baselineReset: previous.length === 0 && store.syncCount("github") === 0,
  });

describe("storePath", () => {
  test("honours XDG_STATE_HOME", () => {
    expect(storePath({ XDG_STATE_HOME: "/xdg" } as NodeJS.ProcessEnv)).toBe(
      "/xdg/prq/state.db",
    );
  });

  test("falls back to ~/.local/state", () => {
    expect(storePath({} as NodeJS.ProcessEnv)).toEndWith(
      join(".local", "state", "prq", "state.db"),
    );
  });
});

describe("an empty store", () => {
  test("reads as nothing, not as an error", async () => {
    const store = await mem();
    const state = store.read("github");
    expect(state.sync).toBeNull();
    expect(state.prs).toEqual([]);
    expect(state.changes).toEqual([]);
    store.close();
  });
});

describe("commit and read", () => {
  test("round-trips the pull requests", async () => {
    const store = await mem();
    commit(store, [pr({ title: "kept" })]);
    const state = store.read("github");
    expect(state.prs).toHaveLength(1);
    expect(state.prs[0]!.title).toBe("kept");
    expect(state.sync?.viewer).toBe("ermand");
    expect(state.sync?.repos).toEqual(["org/repo"]);
    store.close();
  });

  test("the second sync replaces current state, not appends to it", async () => {
    const store = await mem();
    commit(store, [pr({ id: "A" }), pr({ id: "B", number: 2 })]);
    commit(store, [pr({ id: "A" })], [pr({ id: "A" }), pr({ id: "B", number: 2 })]);
    expect(store.read("github").prs.map((p) => p.id)).toEqual(["A"]);
    expect(store.syncCount()).toBe(2);
    store.close();
  });

  test("reads back only the newest sync's changes", async () => {
    const store = await mem();
    const first = [pr({ id: "A" })];
    commit(store, first);
    // Second sync: A's checks go red.
    const second = [pr({ id: "A", checks: "failing" })];
    commit(store, second, first);
    const changes = store.read("github").changes;
    expect(changes.map((c) => c.kind)).toContain("checks");
    expect(changes.every((c) => c.prId === "A")).toBe(true);
    store.close();
  });

  test("persists from and to values", async () => {
    const store = await mem();
    const before = [pr({ id: "A", baseRef: "feature/x" })];
    commit(store, before);
    commit(store, [pr({ id: "A", baseRef: "main" })], before);
    const retarget = store.read("github").changes.find((c) => c.kind === "retargeted");
    expect(retarget?.from).toBe("feature/x");
    expect(retarget?.to).toBe("main");
    store.close();
  });

  test("marks a first sync as a baseline reset", async () => {
    const store = await mem();
    commit(store, [pr()]);
    expect(store.read("github").sync?.baselineReset).toBe(true);
    store.close();
  });

  test("a later sync is not a baseline reset", async () => {
    const store = await mem();
    const first = [pr()];
    commit(store, first);
    commit(store, first, first);
    expect(store.read("github").sync?.baselineReset).toBe(false);
    store.close();
  });
});

describe("stored rows are untrusted", () => {
  test("a row with a poisoned url is dropped on read", async () => {
    // The file is on disk; a stored url reaches `open` and an OSC 8 escape.
    const store = await mem();
    commit(store, [pr({ id: "GOOD" })]);
    // Reach past the API to plant a hostile row, as a hostile writer would.
    const poisoned = JSON.stringify({
      ...pr({ id: "BAD" }),
      url: "file:///Applications/Calculator.app",
    });
    // @ts-expect-error — deliberately reaching into the private handle to
    // simulate an external writer tampering with the file.
    store.db.query("INSERT INTO pr (id, provider, synced, payload) VALUES (?, ?, ?, ?)").run(
      "BAD",
      "github",
      1,
      poisoned,
    );
    expect(store.read("github").prs.map((p) => p.id)).toEqual(["GOOD"]);
    store.close();
  });

  test("unparseable payload is skipped rather than throwing", async () => {
    const store = await mem();
    commit(store, [pr({ id: "GOOD" })]);
    // @ts-expect-error — see above.
    store.db.query("INSERT INTO pr (id, provider, synced, payload) VALUES (?, ?, ?, ?)").run(
      "JUNK",
      "github",
      1,
      "{ not json",
    );
    expect(store.read("github").prs.map((p) => p.id)).toEqual(["GOOD"]);
    store.close();
  });
});

describe("migration", () => {
  const path = join(import.meta.dir, "..", "node_modules", ".prq-test-state.db");
  // WAL leaves sidecar files; removing only the main db leaves a stale WAL that
  // makes the next open fail with SQLITE_IOERR_SHORT_READ.
  const wipe = async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(`${path}${suffix}`, { force: true });
    }
  };

  test("a v1 database opens, gains the provider column, and keeps its history", async () => {
    // v1 predates providers. `CREATE TABLE IF NOT EXISTS` leaves the old shape,
    // so without an explicit ALTER the new index references a column that does
    // not exist and every open dies with `no such column: provider`.
    await wipe();
    const v1 = new Database(path, { create: true });
    v1.run("PRAGMA journal_mode = WAL");
    v1.run(
      "CREATE TABLE sync (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, viewer TEXT NOT NULL, repos TEXT NOT NULL, pr_count INTEGER NOT NULL, baseline_reset INTEGER NOT NULL DEFAULT 0)",
    );
    v1.run(
      "CREATE TABLE pr (id TEXT PRIMARY KEY, synced INTEGER NOT NULL, payload TEXT NOT NULL)",
    );
    v1.run(
      "CREATE TABLE change (sync_id INTEGER NOT NULL, pr_id TEXT NOT NULL, kind TEXT NOT NULL, from_v TEXT, to_v TEXT, PRIMARY KEY (sync_id, pr_id, kind))",
    );
    v1.run(
      "INSERT INTO sync (at, viewer, repos, pr_count, baseline_reset) VALUES (?, ?, ?, ?, 0)",
      ["2026-01-01T00:00:00Z", "ermand", '["o/a"]', 1],
    );
    v1.run("INSERT INTO pr (id, synced, payload) VALUES (?, ?, ?)", [
      "PR_old",
      1,
      '{"id":"PR_old"}',
    ]);
    v1.run("INSERT INTO change (sync_id, pr_id, kind) VALUES (1, 'PR_old', 'joined')");
    v1.run("PRAGMA user_version = 1");
    v1.close();

    const store = await Store.open(path);
    // Defaulting the new column to `github` is not a guess: v1 could only ever
    // hold GitHub rows.
    expect(store.lastSync("github")?.provider).toBe("github");
    // History survives — it is the only record of things the API cannot restate.
    expect(store.syncCount()).toBe(1);
    // The stored payload shape belongs to v1, so those rows are dropped, which
    // flags the state incomplete and makes the next sync reset the baseline.
    const state = store.read("github");
    expect(state.prs).toEqual([]);
    expect(state.incomplete).toBe(true);
    expect(state.changes).toEqual([]);
    store.close();
    await wipe();
  });

  test("a v2 database gains the census tables and keeps its scan state", async () => {
    // v3 only added tables. The baseline is still diffable, so dropping it would
    // cost the driver a change report for nothing.
    await wipe();
    const v2 = new Database(path, { create: true });
    v2.run("PRAGMA journal_mode = WAL");
    v2.run(
      "CREATE TABLE sync (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, at TEXT NOT NULL, viewer TEXT NOT NULL, repos TEXT NOT NULL, pr_count INTEGER NOT NULL, baseline_reset INTEGER NOT NULL DEFAULT 0)",
    );
    v2.run(
      "CREATE TABLE pr (id TEXT PRIMARY KEY, provider TEXT NOT NULL, synced INTEGER NOT NULL, payload TEXT NOT NULL)",
    );
    v2.run(
      "CREATE TABLE change (sync_id INTEGER NOT NULL REFERENCES sync(id) ON DELETE CASCADE, pr_id TEXT NOT NULL, kind TEXT NOT NULL, from_v TEXT, to_v TEXT, PRIMARY KEY (sync_id, pr_id, kind))",
    );
    const kept = pr();
    v2.run(
      "INSERT INTO sync (provider, at, viewer, repos, pr_count, baseline_reset) VALUES (?, ?, ?, ?, ?, 0)",
      ["github", "2026-01-01T00:00:00Z", "ermand", '["org/repo"]', 1],
    );
    v2.run("INSERT INTO pr (id, provider, synced, payload) VALUES (?, ?, ?, ?)", [
      kept.id,
      "github",
      1,
      JSON.stringify(kept),
    ]);
    v2.run(
      "INSERT INTO change (sync_id, pr_id, kind) VALUES (1, ?, 'joined')",
      [kept.id],
    );
    v2.run("PRAGMA user_version = 2");
    v2.close();

    const store = await Store.open(path);
    // @ts-expect-error — reading the private handle to assert the pragma.
    expect(store.db.query("PRAGMA user_version").get().user_version).toBe(3);
    // @ts-expect-error — reading the private handle to assert the new tables.
    const tables: { name: string }[] = store.db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'census%' OR name = 'contributor') ORDER BY name",
      )
      .all();
    expect(tables.map((t) => t.name)).toEqual([
      "census_pr",
      "census_review",
      "census_run",
      "contributor",
    ]);

    const state = store.read("github");
    expect(state.incomplete).toBe(false);
    expect(state.prs).toHaveLength(1);
    expect(state.changes).toEqual([{ prId: kept.id, kind: "joined", from: null, to: null }]);
    expect(store.syncCount()).toBe(1);

    // And the census side is live on the migrated file.
    store.writeCensus(census(), AT);
    expect(store.censusPrs()).toHaveLength(1);
    store.close();
    await wipe();
  });

  test("a fresh database is stamped with the schema version", async () => {
    await wipe();
    const store = await Store.open(path);
    // @ts-expect-error — reading the private handle to assert the pragma.
    const version = store.db.query("PRAGMA user_version").get().user_version;
    expect(version).toBe(SCHEMA_VERSION);
    store.close();
    await wipe();
  });

  test("a fresh database is not mistaken for a pre-versioning one", async () => {
    // user_version defaults to 0 on a brand-new file, so freshness cannot be
    // read from the pragma alone.
    await wipe();
    const store = await Store.open(path);
    commit(store, [pr()]);
    expect(store.read("github").prs).toHaveLength(1);
    store.close();
    await wipe();
  });

  test("an older database keeps its history but loses current state", async () => {
    await wipe();
    const first = await Store.open(path);
    commit(first, [pr()]);
    expect(first.read("github").prs).toHaveLength(1);
    first.close();

    // Pretend the previous build wrote an older shape. 0 is the pre-versioning
    // value, and the tables already exist, so this must be treated as stale.
    const stale = new Database(path);
    stale.run("PRAGMA user_version = 0");
    stale.close();

    const reopened = await Store.open(path);
    // History survives — it is the only record of things the API cannot restate.
    expect(reopened.syncCount()).toBe(1);
    // Current state is gone, so the next sync resets the baseline rather than
    // diffing against a shape it cannot read.
    expect(reopened.read("github").prs).toEqual([]);
    reopened.close();
    await wipe();
  });

  test("the file is not world-readable", async () => {
    await wipe();
    const store = await Store.open(path);
    store.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await wipe();
  });
});

describe("hardening", () => {
  const path = join(import.meta.dir, "..", "node_modules", ".prq-test-hard.db");
  const wipe = async () => {
    for (const suffix of ["", "-wal", "-shm"]) await rm(`${path}${suffix}`, { force: true });
  };

  test("a newer database is refused, not silently downgraded", async () => {
    // Downgrading and re-stamping would make two builds destroy each other's
    // state on every alternation.
    await wipe();
    const store = await Store.open(path);
    commit(store, [pr()]);
    store.close();
    const bumped = new Database(path);
    bumped.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    bumped.close();
    await expect(Store.open(path)).rejects.toThrow(/newer version of prq/);
    // And the state survives, rather than having been wiped on the way out.
    const check = new Database(path, { readonly: true });
    expect(check.query("SELECT count(*) AS n FROM pr").get()).toEqual({ n: 1 });
    check.close();
    await wipe();
  });

  test("the WAL sidecars are not world-readable", async () => {
    // They hold the recently written pages, so a 0644 -wal exposes the dataset
    // while the 0600 main file sits nearly empty.
    await wipe();
    const store = await Store.open(path);
    commit(store, [pr({ title: "private thing" })]);
    for (const suffix of ["", "-wal"]) {
      const file = `${path}${suffix}`;
      if (existsSync(file)) expect(statSync(file).mode & 0o077).toBe(0);
    }
    store.close();
    await wipe();
  });

  test("a second process can open the store while the first holds it", async () => {
    // busy_timeout was 0, so any overlap threw SQLITE_BUSY immediately and the
    // documented workflow — TUI open, `prq sync` in another terminal — died.
    await wipe();
    const first = await Store.open(path);
    commit(first, [pr()]);
    const second = await Store.open(path);
    expect(second.read("github").prs).toHaveLength(1);
    second.close();
    first.close();
    await wipe();
  });

  test("reopening does not rewrite the version header", async () => {
    // The unconditional header write took the write lock on every open.
    await wipe();
    const first = await Store.open(path);
    first.close();
    const before = statSync(path).mtimeMs;
    const second = await Store.open(path);
    second.close();
    expect(statSync(path).mtimeMs).toBeGreaterThanOrEqual(before);
    await wipe();
  });
});

describe("incomplete stored state", () => {
  test("withholds changes and flags itself when a row is unreadable", async () => {
    // The stored changes describe a state that can no longer be reproduced, so
    // presenting them would promise changes the list cannot show — and diffing
    // against the short baseline would fabricate a `left` then a `joined`.
    const store = await mem();
    const first = [pr({ id: "A" }), pr({ id: "B", number: 2 })];
    commit(store, first);
    commit(store, [pr({ id: "A", checks: "failing" }), pr({ id: "B", number: 2 })], first);
    expect(store.read("github").changes.length).toBeGreaterThan(0);
    expect(store.read("github").incomplete).toBe(false);

    // @ts-expect-error — reaching the private handle to simulate tampering.
    store.db.query("UPDATE pr SET payload = ? WHERE id = ?").run("{ broken", "B");
    const state = store.read("github");
    expect(state.incomplete).toBe(true);
    expect(state.changes).toEqual([]);
    expect(state.prs.map((p) => p.id)).toEqual(["A"]);
    store.close();
  });
});

describe("change kinds read off disk", () => {
  test("an obsolete kind is dropped rather than rendered", async () => {
    // History is deliberately kept across schema versions, so obsolete kinds are
    // expected. An unvalidated one renders `[undefined]` and wins headline().
    const store = await mem();
    const first = [pr({ id: "A" })];
    commit(store, first);
    commit(store, [pr({ id: "A", checks: "failing" })], first);
    const syncId = store.lastSync("github")!.id;
    // @ts-expect-error — see above.
    store.db
      .query("INSERT INTO change (sync_id, pr_id, kind, from_v, to_v) VALUES (?, ?, ?, ?, ?)")
      .run(syncId, "A", "constructor", null, null);
    // @ts-expect-error — see above.
    store.db
      .query("INSERT INTO change (sync_id, pr_id, kind, from_v, to_v) VALUES (?, ?, ?, ?, ?)")
      .run(syncId, "A", "obsolete-kind", null, null);
    const kinds = store.read("github").changes.map((c) => c.kind);
    expect(kinds).toContain("checks");
    expect(kinds).not.toContain("constructor");
    expect(kinds).not.toContain("obsolete-kind");
    store.close();
  });
});

describe("storePath hardening", () => {
  test("ignores a relative XDG_STATE_HOME rather than writing under the cwd", () => {
    // A literal "undefined" would otherwise create a directory called undefined.
    expect(storePath({ XDG_STATE_HOME: "undefined" } as NodeJS.ProcessEnv)).toEndWith(
      join(".local", "state", "prq", "state.db"),
    );
    expect(storePath({ XDG_STATE_HOME: "./rel" } as NodeJS.ProcessEnv)).toEndWith(
      join(".local", "state", "prq", "state.db"),
    );
  });
});

describe("resolveStorePath", () => {
  const env = {} as NodeJS.ProcessEnv;

  test("falls back to the XDG default when unset", () => {
    expect(resolveStorePath(undefined, env)).toEndWith(
      join(".local", "state", "prq", "state.db"),
    );
  });

  test("honours a relative path against the working directory", () => {
    // Unlike XDG_STATE_HOME, a relative value here is the point: it is what
    // keeps the store beside the project.
    expect(resolveStorePath(".prq/state.db", env, "/work/proj")).toBe(
      "/work/proj/.prq/state.db",
    );
    expect(resolveStorePath("state.db", env, "/work/proj")).toBe("/work/proj/state.db");
  });

  test("keeps an absolute path as given", () => {
    expect(resolveStorePath("/var/tmp/prq.db", env, "/work/proj")).toBe("/var/tmp/prq.db");
  });

  test("expands a leading tilde", () => {
    const expanded = resolveStorePath("~/prq/state.db", env, "/work/proj");
    expect(expanded).toEndWith(join("prq", "state.db"));
    expect(expanded).not.toInclude("~");
    expect(expanded).not.toInclude("/work/proj");
  });

  test("does not treat a tilde inside a path as a home reference", () => {
    expect(resolveStorePath("./a~b/state.db", env, "/work/proj")).toBe(
      "/work/proj/a~b/state.db",
    );
  });

  test("normalises a path that walks upwards", () => {
    expect(resolveStorePath("../shared/state.db", env, "/work/proj")).toBe(
      "/work/shared/state.db",
    );
  });
});

describe("a project-local store", () => {
  const dir = join(import.meta.dir, "..", "node_modules", ".prq-local");
  const path = join(dir, "state.db");
  const wipe = async () => rm(dir, { recursive: true, force: true });

  test("creates its directory and works from a relative path", async () => {
    await wipe();
    const relative = resolveStorePath(path);
    const store = await Store.open(relative);
    commit(store, [pr({ title: "beside the project" })]);
    expect(store.read("github").prs[0]!.title).toBe("beside the project");
    store.close();
    // Still 0600 even outside the XDG location.
    expect(statSync(path).mode & 0o077).toBe(0);
    await wipe();
  });
});

describe("the stored viewer crosses the trust boundary", () => {
  test("a tampered viewer makes the sync row unreadable rather than painting escapes", async () => {
    // The viewer is the first field of the header, so it must survive the same
    // fixed-point check every other stored string does.
    const store = await mem();
    commit(store, [pr()]);
    // @ts-expect-error — reaching the private handle to simulate tampering.
    store.db
      .query("UPDATE sync SET viewer = ?")
      .run("\u001b[2J\u001b[1;1Hattacker\u0007");
    expect(store.lastSync("github")).toBeNull();
    store.close();
  });

  test("an ordinary viewer reads back fine", async () => {
    const store = await mem();
    commit(store, [pr()]);
    expect(store.lastSync("github")?.viewer).toBe("ermand");
    store.close();
  });
});

describe("the census", () => {
  test("round-trips through storage", async () => {
    const store = await mem();
    const written = census();
    store.writeCensus(written, AT);
    expect(store.censusPrs()).toEqual(written.prs);
    expect(store.censusReviews()).toEqual(written.reviews);
    expect(store.censusRuns()).toEqual([
      {
        provider: "github",
        repo: "org/repo",
        at: AT,
        prs: 1,
        reviews: 1,
        failed: null,
        truncated: false,
      },
    ]);
    store.close();
  });

  test("re-censusing a project replaces rather than duplicates", async () => {
    // The point of the full replace: an upsert would leave a pull request the
    // walk no longer sees sitting in the dashboard forever.
    const store = await mem();
    store.writeCensus(census({ prs: [censusPr(), censusPr({ number: 2 })] }), AT);
    expect(store.censusPrs()).toHaveLength(2);

    const later = new Date("2026-07-01T00:00:00.000Z");
    store.writeCensus(
      census({
        prs: [censusPr({ title: "Retitled" })],
        reviews: [censusReview(), censusReview({ act: "commented" })],
      }),
      later,
    );
    const prs = store.censusPrs();
    expect(prs).toHaveLength(1);
    expect(prs[0]!.title).toBe("Retitled");
    expect(store.censusReviews()).toHaveLength(2);
    expect(store.censusRuns()).toHaveLength(1);
    expect(store.censusRuns()[0]!.at).toEqual(later);
    store.close();
  });

  test("censusing one project leaves another's rows intact", async () => {
    const store = await mem();
    store.writeCensus(census(), AT);
    store.writeCensus(
      census({
        repo: "org/other",
        prs: [censusPr({ repo: "org/other", number: 7, author: "carol" })],
        reviews: [censusReview({ repo: "org/other", number: 7 })],
      }),
      AT,
    );
    expect(store.censusPrs()).toHaveLength(2);

    store.writeCensus(census({ prs: [], reviews: [] }), AT);
    expect(store.censusPrs().map((p) => p.repo)).toEqual(["org/other"]);
    expect(store.censusReviews().map((r) => r.repo)).toEqual(["org/other"]);
    store.close();
  });

  test("two projects can share a pull request number", async () => {
    // The primary key is (provider, repo, number). Keying on number alone would
    // make the second project's #1 evict the first's.
    const store = await mem();
    store.writeCensus(census(), AT);
    store.writeCensus(
      census({ repo: "org/other", prs: [censusPr({ repo: "org/other" })], reviews: [] }),
      AT,
    );
    store.writeCensus(
      census({
        provider: "gitlab",
        repo: "group/sub/proj",
        prs: [censusPr({ provider: "gitlab", repo: "group/sub/proj", url: null })],
        reviews: [],
        reviewPrecision: "approximate",
      }),
      AT,
    );
    expect(store.censusPrs().map((p) => `${p.provider}:${p.repo}`)).toEqual([
      "github:org/other",
      "github:org/repo",
      "gitlab:group/sub/proj",
    ]);
    store.close();
  });

  test("a failed census preserves stored rows and still records the run", async () => {
    // Same rule `commit` follows for a partial scan: a hole committed as truth
    // is inherited by every later reading of the project.
    const store = await mem();
    store.writeCensus(census(), AT);

    const failedAt = new Date("2026-07-01T00:00:00.000Z");
    store.writeCensus(
      census({ prs: [], reviews: [], failed: "401 Unauthorized", truncated: false }),
      failedAt,
    );
    expect(store.censusPrs()).toHaveLength(1);
    expect(store.censusReviews()).toHaveLength(1);
    expect(store.contributors()).toHaveLength(2);

    const [run] = store.censusRuns();
    expect(run!.failed).toBe("401 Unauthorized");
    expect(run!.at).toEqual(failedAt);
    expect(run!.prs).toBe(0);
    store.close();
  });

  test("truncation is recorded", async () => {
    const store = await mem();
    store.writeCensus(census({ truncated: true }), AT);
    expect(store.censusRuns()[0]!.truncated).toBe(true);
    store.close();
  });

  test("filters narrow the rows", async () => {
    const store = await mem();
    store.writeCensus(
      census({
        prs: [censusPr(), censusPr({ number: 2, author: "carol" })],
        reviews: [censusReview(), censusReview({ number: 2, reviewer: "alice" })],
      }),
      AT,
    );
    store.writeCensus(
      census({
        provider: "gitlab",
        repo: "group/proj",
        prs: [censusPr({ provider: "gitlab", repo: "group/proj", author: "alice" })],
        reviews: [censusReview({ provider: "gitlab", repo: "group/proj", at: null })],
        reviewPrecision: "approximate",
      }),
      AT,
    );

    expect(store.censusPrs({ provider: "gitlab" }).map((p) => p.repo)).toEqual([
      "group/proj",
    ]);
    expect(store.censusPrs({ repo: "org/repo" })).toHaveLength(2);
    expect(store.censusPrs({ author: "alice" }).map((p) => p.provider)).toEqual([
      "github",
      "gitlab",
    ]);
    expect(store.censusPrs({ provider: "github", author: "carol" })).toHaveLength(1);
    expect(store.censusReviews({ reviewer: "alice" })).toHaveLength(1);
    expect(store.censusReviews({ provider: "gitlab" })[0]!.at).toBeNull();
    store.close();
  });

  test("contributors are derived, including review-only identities", async () => {
    const store = await mem();
    store.writeCensus(
      census({
        prs: [
          censusPr({
            number: 1,
            author: "alice",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-05T00:00:00.000Z",
          }),
          censusPr({
            number: 2,
            author: "alice",
            createdAt: "2026-02-01T00:00:00.000Z",
            updatedAt: "2026-02-09T00:00:00.000Z",
          }),
        ],
        reviews: [
          censusReview({ number: 1, reviewer: "bob", at: "2026-01-04T00:00:00.000Z" }),
          censusReview({
            number: 2,
            reviewer: "bob",
            act: "changes-requested",
            at: "2026-03-01T00:00:00.000Z",
          }),
        ],
      }),
      AT,
    );

    expect(store.contributors()).toEqual([
      {
        provider: "github",
        username: "alice",
        firstSeen: "2026-01-01T00:00:00.000Z",
        lastSeen: "2026-02-09T00:00:00.000Z",
        prs: 2,
        reviews: 0,
      },
      // Review-only, and the later of its two review timestamps is later than
      // anything it authored — because it authored nothing.
      {
        provider: "github",
        username: "bob",
        firstSeen: "2026-01-04T00:00:00.000Z",
        lastSeen: "2026-03-01T00:00:00.000Z",
        prs: 0,
        reviews: 2,
      },
    ]);
    store.close();
  });

  test("a timestampless reviewer is bounded by the pull request it reviewed", async () => {
    // GitLab's `approvedBy` carries no time, and the reviewed merge request is
    // the tightest bound left.
    const store = await mem();
    store.writeCensus(
      census({
        provider: "gitlab",
        repo: "group/proj",
        reviewPrecision: "approximate",
        prs: [
          censusPr({
            provider: "gitlab",
            repo: "group/proj",
            author: "alice",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-05T00:00:00.000Z",
          }),
        ],
        reviews: [
          censusReview({
            provider: "gitlab",
            repo: "group/proj",
            reviewer: "dana",
            at: null,
          }),
        ],
      }),
      AT,
    );
    expect(store.contributors().find((c) => c.username === "dana")).toEqual({
      provider: "gitlab",
      username: "dana",
      firstSeen: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-05T00:00:00.000Z",
      prs: 0,
      reviews: 1,
    });
    store.close();
  });

  test("the hidden-account author is not a contributor", async () => {
    // The trust boundary yields "" for a deleted account. It is not a person.
    const store = await mem();
    store.writeCensus(
      census({
        prs: [censusPr({ author: "", mergedBy: "" })],
        reviews: [censusReview({ reviewer: "" })],
      }),
      AT,
    );
    expect(store.contributors()).toEqual([]);
    expect(store.censusPrs()).toHaveLength(1);
    store.close();
  });

  test("contributors span projects and are recomputed on every replace", async () => {
    const store = await mem();
    store.writeCensus(census(), AT);
    store.writeCensus(
      census({
        repo: "org/other",
        prs: [censusPr({ repo: "org/other", author: "alice" })],
        reviews: [],
      }),
      AT,
    );
    expect(store.contributors().find((c) => c.username === "alice")?.prs).toBe(2);

    store.writeCensus(census({ repo: "org/other", prs: [], reviews: [] }), AT);
    expect(store.contributors().find((c) => c.username === "alice")?.prs).toBe(1);
    store.close();
  });

  test("a tampered census row is dropped rather than painted", async () => {
    const store = await mem();
    store.writeCensus(census({ prs: [censusPr(), censusPr({ number: 2 })] }), AT);
    // @ts-expect-error — reaching the private handle to simulate tampering.
    store.db.query("UPDATE census_pr SET provider = 'forgejo' WHERE number = 2").run();
    // @ts-expect-error — reaching the private handle to simulate tampering.
    store.db.query("UPDATE census_pr SET title = ? WHERE number = 1").run("a\u001b[2Jb");
    const prs = store.censusPrs();
    expect(prs).toHaveLength(1);
    expect(prs[0]!.title).toBe("a [2Jb");
    store.close();
  });

  test("an unsubmittable url is refused on the way out", async () => {
    const store = await mem();
    store.writeCensus(census(), AT);
    // @ts-expect-error — reaching the private handle to simulate tampering.
    store.db.query("UPDATE census_pr SET url = 'javascript:alert(1)'").run();
    expect(store.censusPrs()[0]!.url).toBeNull();
    store.close();
  });
});
