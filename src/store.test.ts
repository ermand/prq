import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { diff } from "./changes";
import { normalize, type PullRequest, type RawPullRequest } from "./domain";
import { SCHEMA_VERSION, Store, storePath } from "./store";

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
    viewer: "ermand",
    repos: ["org/repo"],
    prs,
    changes: diff(previous, prs),
    baselineReset: previous.length === 0 && store.syncCount() === 0,
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
    const state = store.read();
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
    const state = store.read();
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
    expect(store.read().prs.map((p) => p.id)).toEqual(["A"]);
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
    const changes = store.read().changes;
    expect(changes.map((c) => c.kind)).toContain("checks");
    expect(changes.every((c) => c.prId === "A")).toBe(true);
    store.close();
  });

  test("persists from and to values", async () => {
    const store = await mem();
    const before = [pr({ id: "A", baseRef: "feature/x" })];
    commit(store, before);
    commit(store, [pr({ id: "A", baseRef: "main" })], before);
    const retarget = store.read().changes.find((c) => c.kind === "retargeted");
    expect(retarget?.from).toBe("feature/x");
    expect(retarget?.to).toBe("main");
    store.close();
  });

  test("marks a first sync as a baseline reset", async () => {
    const store = await mem();
    commit(store, [pr()]);
    expect(store.read().sync?.baselineReset).toBe(true);
    store.close();
  });

  test("a later sync is not a baseline reset", async () => {
    const store = await mem();
    const first = [pr()];
    commit(store, first);
    commit(store, first, first);
    expect(store.read().sync?.baselineReset).toBe(false);
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
    store.db.query("INSERT INTO pr (id, synced, payload) VALUES (?, ?, ?)").run(
      "BAD",
      1,
      poisoned,
    );
    expect(store.read().prs.map((p) => p.id)).toEqual(["GOOD"]);
    store.close();
  });

  test("unparseable payload is skipped rather than throwing", async () => {
    const store = await mem();
    commit(store, [pr({ id: "GOOD" })]);
    // @ts-expect-error — see above.
    store.db.query("INSERT INTO pr (id, synced, payload) VALUES (?, ?, ?)").run(
      "JUNK",
      1,
      "{ not json",
    );
    expect(store.read().prs.map((p) => p.id)).toEqual(["GOOD"]);
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
    expect(store.read().prs).toHaveLength(1);
    store.close();
    await wipe();
  });

  test("an older database keeps its history but loses current state", async () => {
    await wipe();
    const first = await Store.open(path);
    commit(first, [pr()]);
    expect(first.read().prs).toHaveLength(1);
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
    expect(reopened.read().prs).toEqual([]);
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
    expect(second.read().prs).toHaveLength(1);
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
    expect(store.read().changes.length).toBeGreaterThan(0);
    expect(store.read().incomplete).toBe(false);

    // @ts-expect-error — reaching the private handle to simulate tampering.
    store.db.query("UPDATE pr SET payload = ? WHERE id = ?").run("{ broken", "B");
    const state = store.read();
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
    const syncId = store.lastSync()!.id;
    // @ts-expect-error — see above.
    store.db
      .query("INSERT INTO change (sync_id, pr_id, kind, from_v, to_v) VALUES (?, ?, ?, ?, ?)")
      .run(syncId, "A", "constructor", null, null);
    // @ts-expect-error — see above.
    store.db
      .query("INSERT INTO change (sync_id, pr_id, kind, from_v, to_v) VALUES (?, ?, ?, ?, ?)")
      .run(syncId, "A", "obsolete-kind", null, null);
    const kinds = store.read().changes.map((c) => c.kind);
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
