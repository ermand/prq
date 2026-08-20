import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { diff } from "./changes";
import { normalize, type PullRequest, type RawPullRequest } from "./domain";
import { resolvePeople, type CensusPr, type CensusReview, type RepoCensus } from "./census";
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
    expect(store.db.query("PRAGMA user_version").get().user_version).toBe(SCHEMA_VERSION);
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

  test("a v3 database gains the tracking tables and keeps every row", async () => {
    // v4 only added tables: the project list and the person rows moved out of
    // config.yaml, and nothing already stored changed shape. A v3 file must
    // therefore keep its baseline, its history and its census.
    await wipe();
    const v3 = new Database(path, { create: true });
    v3.run("PRAGMA journal_mode = WAL");
    v3.run(
      "CREATE TABLE sync (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, at TEXT NOT NULL, viewer TEXT NOT NULL, repos TEXT NOT NULL, pr_count INTEGER NOT NULL, baseline_reset INTEGER NOT NULL DEFAULT 0)",
    );
    v3.run(
      "CREATE TABLE pr (id TEXT PRIMARY KEY, provider TEXT NOT NULL, synced INTEGER NOT NULL, payload TEXT NOT NULL)",
    );
    v3.run(
      "CREATE TABLE change (sync_id INTEGER NOT NULL REFERENCES sync(id) ON DELETE CASCADE, pr_id TEXT NOT NULL, kind TEXT NOT NULL, from_v TEXT, to_v TEXT, PRIMARY KEY (sync_id, pr_id, kind))",
    );
    v3.run(
      "CREATE TABLE census_pr (provider TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, state TEXT NOT NULL, draft INTEGER NOT NULL, title TEXT NOT NULL, url TEXT, author TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, merged_at TEXT, closed_at TEXT, additions INTEGER NOT NULL, deletions INTEGER NOT NULL, files INTEGER NOT NULL, merged_by TEXT NOT NULL, PRIMARY KEY (provider, repo, number))",
    );
    v3.run(
      "CREATE TABLE census_review (provider TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, reviewer TEXT NOT NULL, act TEXT NOT NULL, at TEXT)",
    );
    v3.run(
      "CREATE TABLE census_run (provider TEXT NOT NULL, repo TEXT NOT NULL, at TEXT NOT NULL, prs INTEGER NOT NULL, reviews INTEGER NOT NULL, failed TEXT, truncated INTEGER NOT NULL, PRIMARY KEY (provider, repo))",
    );
    v3.run(
      "CREATE TABLE contributor (provider TEXT NOT NULL, username TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, prs INTEGER NOT NULL, reviews INTEGER NOT NULL, PRIMARY KEY (provider, username))",
    );
    const kept = pr();
    v3.run(
      "INSERT INTO sync (provider, at, viewer, repos, pr_count, baseline_reset) VALUES (?, ?, ?, ?, ?, 0)",
      ["github", "2026-01-01T00:00:00Z", "ermand", '["org/repo"]', 1],
    );
    v3.run("INSERT INTO pr (id, provider, synced, payload) VALUES (?, ?, ?, ?)", [
      kept.id,
      "github",
      1,
      JSON.stringify(kept),
    ]);
    v3.run("INSERT INTO change (sync_id, pr_id, kind) VALUES (1, ?, 'joined')", [kept.id]);
    v3.run(
      "INSERT INTO census_pr (provider, repo, number, state, draft, title, url, author, created_at, updated_at, merged_at, closed_at, additions, deletions, files, merged_by) VALUES ('github', 'org/repo', 1, 'merged', 0, 'A change', NULL, 'alice', '2026-01-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z', NULL, NULL, 1, 1, 1, '')",
    );
    v3.run(
      "INSERT INTO census_review (provider, repo, number, reviewer, act, at) VALUES ('github', 'org/repo', 1, 'bob', 'approved', NULL)",
    );
    v3.run(
      "INSERT INTO census_run (provider, repo, at, prs, reviews, failed, truncated) VALUES ('github', 'org/repo', '2026-01-05T00:00:00.000Z', 1, 1, NULL, 0)",
    );
    v3.run("PRAGMA user_version = 3");
    v3.close();

    const store = await Store.open(path);
    // @ts-expect-error — reading the private handle to assert the pragma.
    expect(store.db.query("PRAGMA user_version").get().user_version).toBe(SCHEMA_VERSION);
    // @ts-expect-error — reading the private handle to assert the new tables.
    const tables: { name: string }[] = store.db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('project', 'person', 'person_alias', 'meta') ORDER BY name",
      )
      .all();
    expect(tables.map((t) => t.name)).toEqual(["meta", "person", "person_alias", "project"]);

    // Nothing stored changed shape, so the baseline is still diffable.
    const state = store.read("github");
    expect(state.incomplete).toBe(false);
    expect(state.prs).toHaveLength(1);
    expect(state.changes).toEqual([{ prId: kept.id, kind: "joined", from: null, to: null }]);
    expect(store.syncCount()).toBe(1);
    expect(store.censusPrs()).toHaveLength(1);
    expect(store.censusReviews()).toHaveLength(1);
    expect(store.censusRuns()).toHaveLength(1);
    // A v3 file was never seeded, so its config lists are still waiting to be
    // imported once.
    expect(store.isSeeded()).toBe(false);
    expect(store.projects()).toEqual([]);
    store.close();
    await wipe();
  });

  test("a v4 database gains the activity marks and keeps every row active", async () => {
    // v5 only *added* columns, both `NOT NULL DEFAULT 1`. Nothing already stored
    // changed shape, so a v4 file keeps its baseline, its history, its census and
    // its tracking — and every project and person reads as active, which is the
    // only safe reading: the mark is a human decision and no migration can infer
    // one.
    await wipe();
    const v4 = new Database(path, { create: true });
    v4.run("PRAGMA journal_mode = WAL");
    v4.run(
      "CREATE TABLE sync (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, at TEXT NOT NULL, viewer TEXT NOT NULL, repos TEXT NOT NULL, pr_count INTEGER NOT NULL, baseline_reset INTEGER NOT NULL DEFAULT 0)",
    );
    v4.run(
      "CREATE TABLE pr (id TEXT PRIMARY KEY, provider TEXT NOT NULL, synced INTEGER NOT NULL, payload TEXT NOT NULL)",
    );
    v4.run(
      "CREATE TABLE change (sync_id INTEGER NOT NULL REFERENCES sync(id) ON DELETE CASCADE, pr_id TEXT NOT NULL, kind TEXT NOT NULL, from_v TEXT, to_v TEXT, PRIMARY KEY (sync_id, pr_id, kind))",
    );
    v4.run(
      "CREATE TABLE census_pr (provider TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, state TEXT NOT NULL, draft INTEGER NOT NULL, title TEXT NOT NULL, url TEXT, author TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, merged_at TEXT, closed_at TEXT, additions INTEGER NOT NULL, deletions INTEGER NOT NULL, files INTEGER NOT NULL, merged_by TEXT NOT NULL, PRIMARY KEY (provider, repo, number))",
    );
    v4.run(
      "CREATE TABLE census_review (provider TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, reviewer TEXT NOT NULL, act TEXT NOT NULL, at TEXT)",
    );
    v4.run(
      "CREATE TABLE census_run (provider TEXT NOT NULL, repo TEXT NOT NULL, at TEXT NOT NULL, prs INTEGER NOT NULL, reviews INTEGER NOT NULL, failed TEXT, truncated INTEGER NOT NULL, PRIMARY KEY (provider, repo))",
    );
    v4.run(
      "CREATE TABLE contributor (provider TEXT NOT NULL, username TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, prs INTEGER NOT NULL, reviews INTEGER NOT NULL, PRIMARY KEY (provider, username))",
    );
    // The v4 tracking tables: no `active` column anywhere.
    v4.run(
      "CREATE TABLE project (provider TEXT NOT NULL, path TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (provider, path))",
    );
    v4.run(
      "CREATE TABLE person (id TEXT NOT NULL PRIMARY KEY, label TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    v4.run(
      "CREATE TABLE person_alias (provider TEXT NOT NULL, username TEXT NOT NULL, person_id TEXT NOT NULL, PRIMARY KEY (provider, username))",
    );
    v4.run("CREATE TABLE meta (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL)");

    const kept = pr();
    v4.run(
      "INSERT INTO sync (provider, at, viewer, repos, pr_count, baseline_reset) VALUES (?, ?, ?, ?, ?, 0)",
      ["github", "2026-01-01T00:00:00Z", "ermand", '["org/repo"]', 1],
    );
    v4.run("INSERT INTO pr (id, provider, synced, payload) VALUES (?, ?, ?, ?)", [
      kept.id,
      "github",
      1,
      JSON.stringify(kept),
    ]);
    v4.run("INSERT INTO change (sync_id, pr_id, kind) VALUES (1, ?, 'joined')", [kept.id]);
    v4.run(
      "INSERT INTO census_pr (provider, repo, number, state, draft, title, url, author, created_at, updated_at, merged_at, closed_at, additions, deletions, files, merged_by) VALUES ('github', 'org/repo', 1, 'merged', 0, 'A change', NULL, 'alice', '2026-01-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z', NULL, NULL, 1, 1, 1, '')",
    );
    v4.run(
      "INSERT INTO census_review (provider, repo, number, reviewer, act, at) VALUES ('github', 'org/repo', 1, 'bob', 'approved', NULL)",
    );
    v4.run(
      "INSERT INTO census_run (provider, repo, at, prs, reviews, failed, truncated) VALUES ('github', 'org/repo', '2026-01-05T00:00:00.000Z', 1, 1, NULL, 0)",
    );
    v4.run(
      "INSERT INTO project (provider, path, added_at) VALUES ('github', 'org/repo', '2026-01-01T00:00:00.000Z')",
    );
    v4.run(
      "INSERT INTO person (id, label, updated_at) VALUES ('github:kaziu', 'Kristi Aziu', '2026-01-01T00:00:00.000Z')",
    );
    v4.run(
      "INSERT INTO person_alias (provider, username, person_id) VALUES ('github', 'kaziu', 'github:kaziu')",
    );
    v4.run("INSERT INTO meta (key, value) VALUES ('tracking.seeded', '2026-01-01T00:00:00.000Z')");
    v4.run("PRAGMA user_version = 4");
    v4.close();

    const store = await Store.open(path);
    // @ts-expect-error — reading the private handle to assert the pragma.
    expect(store.db.query("PRAGMA user_version").get().user_version).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(5);

    // Nothing stored changed shape, so the baseline is still diffable.
    const state = store.read("github");
    expect(state.incomplete).toBe(false);
    expect(state.prs).toHaveLength(1);
    expect(state.changes).toEqual([{ prId: kept.id, kind: "joined", from: null, to: null }]);
    expect(store.censusPrs()).toHaveLength(1);
    expect(store.censusReviews()).toHaveLength(1);
    expect(store.censusRuns()).toHaveLength(1);

    // The tracking rows survive, marked active, and the seed marker with them.
    expect(store.isSeeded()).toBe(true);
    expect(store.projects()).toEqual([
      {
        provider: "github",
        path: "org/repo",
        addedAt: "2026-01-01T00:00:00.000Z",
        active: true,
      },
    ]);
    expect(store.projectsByProvider()).toEqual({ github: ["org/repo"], gitlab: [] });
    expect(store.personRules()).toEqual([
      {
        id: "github:kaziu",
        label: "Kristi Aziu",
        aliases: [{ provider: "github", username: "kaziu" }],
        active: true,
      },
    ]);
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

const LATER = new Date("2026-06-02T00:00:00.000Z");

/** Census rows still on disk, tracked or not. Deliberately not through a reader. */
const rowsOnDisk = (store: Store, table: "census_pr" | "census_review"): number =>
  // @ts-expect-error — reaching the private handle: the point is what the file
  // holds, not what a page would show.
  store.db.query(`SELECT count(*) AS n FROM ${table}`).get().n;

describe("tracked projects", () => {
  test("are added, listed and removed", async () => {
    const store = await mem();
    expect(store.addProject("github", "org/repo", AT)).toBe(true);
    expect(store.addProject("gitlab", "group/sub/project", LATER)).toBe(true);
    // A duplicate is a slip, not an error: the caller is a keystroke.
    expect(store.addProject("github", "org/repo", LATER)).toBe(false);
    expect(store.projects()).toEqual([
      { provider: "github", path: "org/repo", addedAt: AT.toISOString(), active: true },
      {
        provider: "gitlab",
        path: "group/sub/project",
        addedAt: LATER.toISOString(),
        active: true,
      },
    ]);

    expect(store.removeProject("github", "org/repo")).toBe(true);
    expect(store.removeProject("github", "org/repo")).toBe(false);
    expect(store.projects().map((p) => p.path)).toEqual(["group/sub/project"]);
    store.close();
  });

  test("a path must satisfy its own provider's shape", async () => {
    const store = await mem();
    // GitHub paths are interpolated into a search string, where a third segment
    // or a space injects a qualifier and silently widens the scan.
    expect(() => store.addProject("github", "group/sub/project", AT)).toThrow(
      /must be owner\/name/,
    );
    expect(() => store.addProject("github", "cli", AT)).toThrow(/rejected: "cli"/);
    expect(() => store.addProject("github", "o/a is:private", AT)).toThrow(/owner\/name/);
    // GitLab nests as deeply as it likes, but still rejects nonsense.
    expect(store.addProject("gitlab", "a/b/c/d/e", AT)).toBe(true);
    expect(() => store.addProject("gitlab", "nogroup", AT)).toThrow(/group\/project/);
    expect(() => store.addProject("gitlab", "a//b", AT)).toThrow(/rejected: "a\/\/b"/);
    expect(() => store.addProject("gitlab", "a/b c", AT)).toThrow(/group\/project/);
    expect(store.projects().map((p) => p.path)).toEqual(["a/b/c/d/e"]);
    store.close();
  });

  test("come back out in the shape a scan takes", async () => {
    const store = await mem();
    store.addProject("github", "org/repo", AT);
    store.addProject("github", "org/other", AT);
    store.addProject("gitlab", "group/project", AT);
    expect(store.projectsByProvider()).toEqual({
      github: ["org/other", "org/repo"],
      gitlab: ["group/project"],
    });

    store.removeProject("gitlab", "group/project");
    // A provider with nothing tracked is an empty list, not a missing key: the
    // scan takes both providers every time.
    expect(store.projectsByProvider()).toEqual({
      github: ["org/other", "org/repo"],
      gitlab: [],
    });
    store.close();
  });

  test("removing one keeps its census rows on disk", async () => {
    // The rule: untracking hides history, it does not delete it. A mis-click
    // would otherwise cost a full re-census, measured at 2m21s for one project.
    const store = await mem();
    store.addProject("github", "org/repo", AT);
    store.writeCensus(census(), AT);
    expect(rowsOnDisk(store, "census_pr")).toBe(1);

    expect(store.removeProject("github", "org/repo")).toBe(true);
    expect(store.projects()).toEqual([]);
    expect(rowsOnDisk(store, "census_pr")).toBe(1);
    expect(rowsOnDisk(store, "census_review")).toBe(1);

    // Re-adding restores the history instantly, with no census in between.
    expect(store.addProject("github", "org/repo", LATER)).toBe(true);
    expect(store.censusPrs({ repo: "org/repo" })).toHaveLength(1);
    store.close();
  });
});

describe("seeding from a config file", () => {
  const projects = { github: ["org/repo"], gitlab: ["group/project"] };

  test("happens once and is recorded", async () => {
    const store = await mem();
    expect(store.isSeeded()).toBe(false);
    expect(store.seedTracking(projects, [], AT)).toBe(true);
    expect(store.isSeeded()).toBe(true);
    expect(store.projects()).toEqual([
      { provider: "github", path: "org/repo", addedAt: AT.toISOString(), active: true },
      { provider: "gitlab", path: "group/project", addedAt: AT.toISOString(), active: true },
    ]);
    store.close();
  });

  test("does not resurrect the config after every project is deleted", async () => {
    // The whole reason the marker is a stored fact. Keyed on "the project table
    // is empty", deleting your last project brings the entire config file back
    // on the next launch — which is exactly what driving the prototype showed.
    const store = await mem();
    expect(store.seedTracking(projects, [], AT)).toBe(true);
    for (const project of store.projects()) {
      store.removeProject(project.provider, project.path);
    }
    expect(store.projects()).toEqual([]);

    expect(store.seedTracking(projects, [], LATER)).toBe(false);
    expect(store.projects()).toEqual([]);
    store.close();
  });

  test("gives a seeded person the id the config-derived build gave them", async () => {
    const store = await mem();
    store.seedTracking({ github: [], gitlab: [] }, [
      {
        label: "Kristi Aziu",
        aliases: [
          { provider: "github", username: "kaziu" },
          { provider: "gitlab", username: "kristi" },
        ],
      },
    ], AT);
    // The id `resolvePeople` derives from the label, so no profile URL moves
    // when the lists come out of the file.
    expect(store.personRules()).toEqual([
      {
        id: "kristi-aziu",
        label: "Kristi Aziu",
        aliases: [
          { provider: "github", username: "kaziu" },
          { provider: "gitlab", username: "kristi" },
        ],
        active: true,
      },
    ]);
    store.close();
  });

  test("a bad seed path is refused before anything is written", async () => {
    const store = await mem();
    expect(() => store.seedTracking({ github: ["a/b/c"], gitlab: [] }, [], AT)).toThrow(
      /owner\/name/,
    );
    expect(store.isSeeded()).toBe(false);
    expect(store.projects()).toEqual([]);
    store.close();
  });
});

describe("stored people", () => {
  test("a rename on a never-seen identity creates the person and its account", async () => {
    // Materialising the alias row is the fix for a bug found by driving the
    // prototype: with accounts derived from visible census rows only, renaming
    // somebody and then untracking their only project left a name attached to
    // nothing on the roster.
    const store = await mem();
    store.renamePerson("github:kaziu", "Kristi Aziu", AT);
    expect(store.personRules()).toEqual([
      {
        id: "github:kaziu",
        label: "Kristi Aziu",
        aliases: [{ provider: "github", username: "kaziu" }],
        active: true,
      },
    ]);
    store.close();
  });

  test("renaming twice updates in place", async () => {
    const store = await mem();
    store.renamePerson("github:kaziu", "Kristi Aziu", AT);
    store.renamePerson("github:kaziu", "K. Aziu", LATER);
    const rules = store.personRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.label).toBe("K. Aziu");
    expect(rules[0]!.aliases).toHaveLength(1);
    store.close();
  });

  test("a blank name is refused, and a control character never reaches the roster", async () => {
    const store = await mem();
    expect(() => store.renamePerson("github:kaziu", "   ", AT)).toThrow(/cannot be blank/);
    expect(store.personRules()).toEqual([]);
    store.renamePerson("github:kaziu", " Kristi\u001b[2J ", AT);
    expect(store.personRules()[0]!.label).toBe("Kristi [2J");
    store.close();
  });

  test("a slug id claims no account by itself", async () => {
    // A config-seeded person's id is a slug, which names nobody on any forge.
    const store = await mem();
    store.renamePerson("kristi-aziu", "Kristi Aziu", AT);
    expect(store.personRules()).toEqual([
      { id: "kristi-aziu", label: "Kristi Aziu", aliases: [], active: true },
    ]);
    store.close();
  });

  test("round-trip ids so resolvePeople keeps them", async () => {
    const store = await mem();
    store.renamePerson("github:kaziu", "Kristi Aziu", AT);
    const { people, of } = resolvePeople(
      [
        { provider: "github", username: "kaziu" },
        { provider: "github", username: "alice" },
      ],
      store.personRules(),
    );
    // The stored id is used verbatim: derived from the label it would change on
    // every rename and orphan every URL pointing at the person.
    expect(of.get("github:kaziu")).toBe("github:kaziu");
    expect(people.find((p) => p.id === "github:kaziu")?.label).toBe("Kristi Aziu");
    // Anyone unnamed still stands alone under their own login.
    expect(people.find((p) => p.id === "github:alice")?.label).toBe("alice");
    store.close();
  });

  test("a merge moves the accounts and deletes the source person", async () => {
    const store = await mem();
    store.renamePerson("github:kaziu", "Kristi Aziu", AT);
    store.renamePerson("gitlab:kristi", "Kristi A", AT);
    expect(store.mergePersons("gitlab:kristi", "github:kaziu", LATER)).toBe(true);

    // The target keeps its own id and label; both accounts now hang off it.
    expect(store.personRules()).toEqual([
      {
        id: "github:kaziu",
        label: "Kristi Aziu",
        aliases: [
          { provider: "github", username: "kaziu" },
          { provider: "gitlab", username: "kristi" },
        ],
        active: true,
      },
    ]);
    store.close();
  });

  test("a merge works on identities nobody has ever named", async () => {
    // Neither side has a row yet, so the alias the move rewrites has to be
    // created first — the common case, since the roster offers census-derived
    // identities.
    //
    // Both accounts are anchored, not just the moved one. This assertion used to
    // expect only `gitlab:kristi`, which encoded a bug: with the target's own
    // account left unclaimed, `resolvePeople` pushed it a second time and the
    // roster showed one human twice with the counts split between the halves.
    const store = await mem();
    expect(store.mergePersons("gitlab:kristi", "github:kaziu", AT)).toBe(true);
    expect(store.personRules()).toEqual([
      {
        id: "github:kaziu",
        // No label was ever typed, so the target falls back to its own login.
        label: "kaziu",
        aliases: [
          { provider: "github", username: "kaziu" },
          { provider: "gitlab", username: "kristi" },
        ],
        active: true,
      },
    ]);
    store.close();
  });

  test("a merge refuses the same person, and anything it cannot move", async () => {
    const store = await mem();
    expect(store.mergePersons("github:kaziu", "github:kaziu", AT)).toBe(false);
    // Not an identity id, and no stored row: there is no person here to fold.
    expect(store.mergePersons("kristi-aziu", "github:kaziu", AT)).toBe(false);
    expect(store.personRules()).toEqual([]);
    store.close();
  });

  test("a split un-claims one account and leaves the name standing", async () => {
    const store = await mem();
    store.renamePerson("github:kaziu", "Kristi Aziu", AT);
    store.mergePersons("gitlab:kristi", "github:kaziu", AT);

    expect(store.splitAlias("gitlab", "kristi")).toBe(true);
    expect(store.splitAlias("gitlab", "kristi")).toBe(false);
    expect(store.personRules()).toEqual([
      {
        id: "github:kaziu",
        label: "Kristi Aziu",
        aliases: [{ provider: "github", username: "kaziu" }],
        active: true,
      },
    ]);

    // Splitting the last account keeps the person: a name with nothing under it
    // is still a name somebody typed, and dropping it would make it vanish.
    expect(store.splitAlias("github", "kaziu")).toBe(true);
    expect(store.personRules()).toEqual([
      { id: "github:kaziu", label: "Kristi Aziu", aliases: [], active: true },
    ]);
    store.close();
  });

  test("a username is not a project path", async () => {
    const store = await mem();
    expect(() => store.splitAlias("github", "org/repo")).toThrow(/no separator/);
    expect(() => store.splitAlias("github", "two words")).toThrow(/no whitespace/);
    store.close();
  });
});

describe("purging untracked history", () => {
  test("deletes only the untracked rows and returns the count", async () => {
    const store = await mem();
    store.addProject("github", "org/repo", AT);
    store.addProject("github", "org/other", AT);
    store.writeCensus(census({ prs: [censusPr(), censusPr({ number: 2 })] }), AT);
    store.writeCensus(
      census({
        repo: "org/other",
        prs: [censusPr({ repo: "org/other", number: 7, author: "carol" })],
        reviews: [censusReview({ repo: "org/other", number: 7, reviewer: "alice" })],
      }),
      AT,
    );
    expect(rowsOnDisk(store, "census_pr")).toBe(3);

    // Nothing is untracked yet, so a purge is a no-op.
    expect(store.purgeUntracked()).toBe(0);
    expect(rowsOnDisk(store, "census_pr")).toBe(3);

    store.removeProject("github", "org/other");
    // One pull request and one review belonged to the untracked project.
    expect(store.purgeUntracked()).toBe(2);
    expect(store.censusPrs().map((p) => p.repo)).toEqual(["org/repo", "org/repo"]);
    expect(rowsOnDisk(store, "census_pr")).toBe(2);
    expect(store.censusRuns().map((r) => r.repo)).toEqual(["org/repo"]);
    // `contributor` is derived, so it must not keep counting rows that are gone.
    expect(store.contributors().map((c) => c.username)).toEqual(["alice", "bob"]);
    expect(store.purgeUntracked()).toBe(0);
    store.close();
  });

  test("takes the run record of an untracked project that never yielded rows", async () => {
    // A failed census records the attempt and no history. Left behind, the
    // projects page would keep showing a last-scanned time for a project nobody
    // tracks any more.
    const store = await mem();
    store.addProject("github", "org/repo", AT);
    store.writeCensus(census({ prs: [], reviews: [], failed: "token expired" }), AT);
    expect(store.censusRuns()).toHaveLength(1);

    store.removeProject("github", "org/repo");
    expect(store.purgeUntracked()).toBe(0);
    expect(store.censusRuns()).toEqual([]);
    store.close();
  });
});

describe("merging into an identity that was never named", () => {
  test("yields one person, not two sharing an id", async () => {
    // Found by driving the UI: `resolvePeople` saw a rule holding only the moved
    // alias, then the target's own contributor key fell through unclaimed and was
    // pushed a second time — one human listed twice with the counts split.
    const store = await mem();
    const at = new Date("2026-08-20T12:00:00.000Z");

    expect(store.mergePersons("gitlab:marin.hysollari", "github:mhysollari", at)).toBe(true);

    const rules = store.personRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.id).toBe("github:mhysollari");
    expect(rules[0]?.aliases.map((a) => `${a.provider}:${a.username}`).sort()).toEqual([
      "github:mhysollari",
      "gitlab:marin.hysollari",
    ]);

    // And the identities really resolve onto one person, which is the property
    // the roster depends on.
    const { people } = resolvePeople(
      [
        { provider: "github", username: "mhysollari" },
        { provider: "gitlab", username: "marin.hysollari" },
      ],
      rules,
    );
    expect(people).toHaveLength(1);
    store.close();
  });
});

/** Rows the file holds in a table no reader exposes directly. */
const storedRows = (store: Store, table: "person" | "person_alias"): number =>
  // @ts-expect-error — reaching the private handle: materialising the row is the
  // property under test, and `personRules` cannot tell a stored row from the
  // fallback it synthesises for an orphaned alias.
  store.db.query(`SELECT count(*) AS n FROM ${table}`).get().n;

describe("a project's activity mark", () => {
  test("a newly tracked project is active", async () => {
    const store = await mem();
    store.addProject("github", "org/repo", AT);
    expect(store.projects()[0]!.active).toBe(true);
    expect(store.projectsByProvider()).toEqual({ github: ["org/repo"], gitlab: [] });
    store.close();
  });

  test("marking one inactive stops it being fetched and nothing else", async () => {
    // Rule 1, and both halves of it matter. The project stays on the page with
    // its mark, because its stored rows still count everywhere; it drops out of
    // the one list a fetch consumes, which is the entire behavioural difference.
    const store = await mem();
    store.addProject("github", "org/repo", AT);
    store.addProject("github", "org/other", AT);

    expect(store.setProjectActive("github", "org/repo", false)).toBe(true);
    expect(store.projects()).toEqual([
      { provider: "github", path: "org/other", addedAt: AT.toISOString(), active: true },
      { provider: "github", path: "org/repo", addedAt: AT.toISOString(), active: false },
    ]);
    expect(store.projectsByProvider()).toEqual({ github: ["org/other"], gitlab: [] });

    // And it comes back to the fetch list on being marked active again.
    expect(store.setProjectActive("github", "org/repo", true)).toBe(true);
    expect(store.projects().map((p) => p.active)).toEqual([true, true]);
    expect(store.projectsByProvider()).toEqual({
      github: ["org/other", "org/repo"],
      gitlab: [],
    });
    store.close();
  });

  test("a project nobody tracks cannot be marked", async () => {
    // Untracked is not inactive: there is no row to carry the mark, and inventing
    // one would track a project by marking it.
    const store = await mem();
    expect(store.setProjectActive("github", "org/repo", false)).toBe(false);
    expect(store.projects()).toEqual([]);

    store.addProject("github", "org/repo", AT);
    store.removeProject("github", "org/repo");
    expect(store.setProjectActive("github", "org/repo", false)).toBe(false);
    store.close();
  });

  test("an inactive project's census rows are still read back", async () => {
    // Rule 2. History is a record: the read paths are unfiltered and only the
    // fetching changes. Dropping the rows instead rewrote a project's history
    // every time it went dormant.
    const store = await mem();
    store.addProject("github", "org/repo", AT);
    store.writeCensus(census(), AT);
    expect(store.setProjectActive("github", "org/repo", false)).toBe(true);

    expect(store.censusPrs()).toHaveLength(1);
    expect(store.censusPrs({ repo: "org/repo" }).map((p) => p.author)).toEqual(["alice"]);
    expect(store.censusReviews({ repo: "org/repo" })).toHaveLength(1);
    expect(store.censusRuns().map((r) => r.repo)).toEqual(["org/repo"]);
    expect(store.contributors().map((c) => c.username)).toEqual(["alice", "bob"]);
    store.close();
  });

  test("purging spares an inactive project, because it is still tracked", async () => {
    // The distinction the whole design rests on. Inactive keeps the history and
    // untracked hides it, so only the second is an orphan the purge may reclaim.
    const store = await mem();
    store.addProject("github", "org/repo", AT);
    store.addProject("github", "org/other", AT);
    store.writeCensus(census(), AT);
    store.writeCensus(
      census({
        repo: "org/other",
        prs: [censusPr({ repo: "org/other", number: 7, author: "carol" })],
        reviews: [censusReview({ repo: "org/other", number: 7, reviewer: "alice" })],
      }),
      AT,
    );
    expect(rowsOnDisk(store, "census_pr")).toBe(2);

    expect(store.setProjectActive("github", "org/repo", false)).toBe(true);
    expect(store.purgeUntracked()).toBe(0);
    expect(rowsOnDisk(store, "census_pr")).toBe(2);
    expect(rowsOnDisk(store, "census_review")).toBe(2);

    // Untracking the same project is what makes its rows purgeable.
    store.removeProject("github", "org/repo");
    expect(store.purgeUntracked()).toBe(2);
    expect(rowsOnDisk(store, "census_pr")).toBe(1);
    store.close();
  });
});

describe("a person's activity mark", () => {
  test("marking a never-seen identity creates the person and its account", async () => {
    // Rule 3, and the same materialisation `renamePerson` does: the roster offers
    // census-derived identities, so an identity nobody has ever named must still
    // be markable — and without the alias row the mark would detach from the
    // account on the next merge or untracking.
    const store = await mem();
    store.setPersonActive("github:kaziu", false, AT);

    expect(storedRows(store, "person")).toBe(1);
    expect(storedRows(store, "person_alias")).toBe(1);
    expect(store.personRules()).toEqual([
      {
        id: "github:kaziu",
        // Nobody typed a name, so the label falls back to the login.
        label: "kaziu",
        aliases: [{ provider: "github", username: "kaziu" }],
        active: false,
      },
    ]);
    store.close();
  });

  test("the mark reaches resolvePeople, and an unclaimed identity stays active", async () => {
    const store = await mem();
    store.setPersonActive("github:kaziu", false, AT);
    const { people } = resolvePeople(
      [
        { provider: "github", username: "kaziu" },
        { provider: "github", username: "alice" },
      ],
      store.personRules(),
    );
    expect(people.find((p) => p.id === "github:kaziu")?.active).toBe(false);
    // Nobody has stored an opinion about alice, and no opinion means active.
    expect(people.find((p) => p.id === "github:alice")?.active).toBe(true);
    store.close();
  });

  test("marking active again flips it back", async () => {
    const store = await mem();
    store.setPersonActive("github:kaziu", false, AT);
    expect(store.personRules()[0]!.active).toBe(false);

    store.setPersonActive("github:kaziu", true, LATER);
    expect(store.personRules()[0]!.active).toBe(true);
    expect(storedRows(store, "person")).toBe(1);
    store.close();
  });

  test("marking somebody does not disturb the name they were given", async () => {
    // The upsert deliberately touches `active` only: this is not a rename, and
    // being marked inactive must not reduce a named person to their login.
    const store = await mem();
    store.renamePerson("github:kaziu", "Kristi Aziu", AT);
    store.setPersonActive("github:kaziu", false, LATER);

    expect(store.personRules()).toEqual([
      {
        id: "github:kaziu",
        label: "Kristi Aziu",
        aliases: [{ provider: "github", username: "kaziu" }],
        active: false,
      },
    ]);

    // And renaming somebody inactive does not quietly reactivate them either.
    store.renamePerson("github:kaziu", "K. Aziu", LATER);
    expect(store.personRules()[0]!.label).toBe("K. Aziu");
    expect(store.personRules()[0]!.active).toBe(false);
    store.close();
  });

  test("an inactive person's pull requests still count", async () => {
    // Rule 2 again, on the other axis. Somebody leaving does not un-write their
    // code; driving the alternative erased 11 real pull requests from a profile.
    const store = await mem();
    store.addProject("github", "org/repo", AT);
    store.writeCensus(census(), AT);
    store.setPersonActive("github:alice", false, LATER);

    expect(store.censusPrs({ author: "alice" })).toHaveLength(1);
    expect(store.contributors().find((c) => c.username === "alice")?.prs).toBe(1);
    store.close();
  });

  test("a person needs an id to be marked", async () => {
    const store = await mem();
    expect(() => store.setPersonActive("", false, AT)).toThrow(/needs an id/);
    expect(store.personRules()).toEqual([]);
    store.close();
  });
});
