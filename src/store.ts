/**
 * The state store.
 *
 * Sync is an explicit act; this file holds what it commits. The store answers
 * two questions the API cannot: what the state was at the last sync, and what
 * changed since.
 *
 * Schema, retention and migration policy are wayfinder ticket 0014, still open —
 * the choices here are prototype-grade:
 *   - Current state per PR, plus an append-only change log. Not a row per PR per
 *     sync: the log is what gets read, and it stays small.
 *   - Derived model, not raw API responses. Queryable, at the cost of needing a
 *     schema version — which the JSON cache already needed.
 *   - No pruning yet. Change rows are tiny; growth is a real question but not
 *     one to guess at.
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { chmod, mkdir, open } from "node:fs/promises";
import { APP_NAME } from "./config";
import { isChangeKind, type Change, type ChangeKind } from "./changes";
import { isClean, isPullRequest, type Provider, type PullRequest } from "./domain";

/** Bumped whenever the schema or the shape of a stored PR changes. */
export const SCHEMA_VERSION = 2;

export function storePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.XDG_STATE_HOME;
  // A relative XDG_STATE_HOME would silently write under the cwd — and the
  // literal string "undefined" would create a directory called `undefined`.
  const base =
    configured && isAbsolute(configured) ? configured : join(homedir(), ".local", "state");
  return join(base, APP_NAME, "state.db");
}

/**
 * Resolves a configured or flag-supplied store location.
 *
 * Unlike `XDG_STATE_HOME`, a relative value here is honoured and resolved
 * against the working directory — that is the whole point of the setting, which
 * exists so the store can sit beside a project rather than in a home directory.
 */
export function resolveStorePath(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  if (configured === undefined) return storePath(env);
  const expanded =
    configured === "~" || configured.startsWith("~/")
      ? join(homedir(), configured.slice(1))
      : configured;
  return resolve(cwd, expanded);
}

const TABLES = `
CREATE TABLE IF NOT EXISTS sync (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  provider       TEXT    NOT NULL,
  at             TEXT    NOT NULL,
  viewer         TEXT    NOT NULL,
  repos          TEXT    NOT NULL,
  pr_count       INTEGER NOT NULL,
  baseline_reset INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pr (
  id       TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  synced   INTEGER NOT NULL,
  payload  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS change (
  sync_id INTEGER NOT NULL REFERENCES sync(id) ON DELETE CASCADE,
  pr_id   TEXT    NOT NULL,
  kind    TEXT    NOT NULL,
  from_v  TEXT,
  to_v    TEXT,
  PRIMARY KEY (sync_id, pr_id, kind)
);
`;

/**
 * Created after any column-adding migration, never in the same statement batch:
 * an index on a column an older table does not have yet fails the whole open.
 */
const INDEXES = `
CREATE INDEX IF NOT EXISTS sync_by_provider ON sync(provider, id);
CREATE INDEX IF NOT EXISTS pr_by_provider ON pr(provider);
CREATE INDEX IF NOT EXISTS change_by_sync ON change(sync_id);
`;

export interface SyncRecord {
  id: number;
  provider: Provider;
  at: string;
  viewer: string;
  repos: string[];
  prCount: number;
  /** True when no diff was computable — a first sync, or after a schema reset. */
  baselineReset: boolean;
}

/**
 * One provider's committed state.
 *
 * Baselines are per-provider: a provider that fails to scan freezes only its own
 * diff, never the other's. That matters because the driver's GitLab token expired
 * once, and an all-or-nothing rule would have frozen the memory of 29 GitHub PRs
 * over 8 GitLab MRs.
 */
export interface StoredState {
  sync: SyncRecord | null;
  prs: PullRequest[];
  /** Changes recorded by the most recent sync of this provider. */
  changes: Change[];
  /**
   * Stored rows were lost — to a schema drop, or to validation. The changes are
   * withheld when this is set, because they describe a state we cannot rebuild.
   */
  incomplete: boolean;
}

interface SyncRow {
  id: number;
  at: string;
  viewer: string;
  repos: string;
  pr_count: number;
  baseline_reset: number;
}

export class Store {
  private constructor(private readonly db: Database) {}

  static async open(path = storePath()): Promise<Store> {
    if (path !== ":memory:") {
      const dir = dirname(path);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      try {
        // mkdir's mode does not apply to a directory that already exists, so
        // tighten it — but best-effort: the caller may point `statePath` at a
        // directory that is not ours to change, and /tmp refuses outright.
        // The 0600 on the files below is the protection that actually matters.
        await chmod(dir, 0o700);
      } catch {
        // Not ours to tighten. Leave it as the owner set it.
      }
    }
    if (path !== ":memory:") {
      // Created 0600 up front rather than at the ambient umask and tightened
      // afterwards: a local process opening the file in that window keeps a read
      // descriptor that survives the chmod.
      const handle = await open(path, "a", 0o600);
      await handle.close();
    }
    const db = new Database(path, { create: true });
    // Ordered deliberately: SQLite copies the database's mode onto the -wal and
    // -shm sidecars when it creates them, so the chmod must land *before* WAL is
    // enabled. The sidecars hold the recently written pages, so a 0644 -wal
    // exposes the whole dataset while the 0600 main file sits nearly empty.
    if (path !== ":memory:") await chmod(path, 0o600);
    // bun:sqlite leaves busy_timeout at 0, so any overlap with another prq
    // process throws SQLITE_BUSY on the first conflict with no retry. Set it
    // before the first write, which is the WAL pragma itself.
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    // Freed pages are otherwise left intact, so every PR title and private repo
    // name the tool has ever seen stays greppable in the file long after the row
    // is replaced.
    db.run("PRAGMA secure_delete = ON");
    const store = new Store(db);
    store.migrate(path);
    // Still worth doing for a database an older build created 0644.
    if (path !== ":memory:") await chmod(path, 0o600);
    return store;
  }

  /**
   * Brings an existing database up to `SCHEMA_VERSION`.
   *
   * Current state is dropped whenever the version moves, because the stored
   * payload shape belongs to the build that wrote it. Change **history** is kept:
   * those rows are self-describing and are the only record of things the API can
   * no longer tell us. Dropping current state forces the next sync to reset the
   * baseline rather than diff against a shape it cannot read.
   */
  private migrate(path: string): void {
    // `user_version` defaults to 0, so it cannot distinguish a brand-new file
    // from one written before versioning existed. Table presence can.
    const fresh =
      this.db
        .query<
          { n: number },
          []
        >("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='sync'")
        .get()!.n === 0;

    const { user_version: version } = this.db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()!;

    // A newer database must not be silently stripped and re-stamped backwards:
    // alternating between two builds would make each destroy the other's state.
    if (!fresh && version > SCHEMA_VERSION) {
      throw new Error(
        `${path} was written by a newer version of prq ` +
          `(store schema v${version}, this build understands v${SCHEMA_VERSION}). ` +
          `Upgrade prq, or delete the file to start over.`,
      );
    }

    this.db.run(TABLES);

    // v1 predates providers. `CREATE TABLE IF NOT EXISTS` leaves the old shape
    // untouched, so the column has to be added explicitly — and before the
    // indexes below, which reference it. Defaulting to `github` is not a guess:
    // v1 could only ever hold GitHub rows.
    if (!fresh && version < 2) {
      for (const table of ["sync", "pr"]) {
        if (!this.hasColumn(table, "provider")) {
          this.db.run(
            `ALTER TABLE ${table} ADD COLUMN provider TEXT NOT NULL DEFAULT 'github'`,
          );
        }
      }
    }

    this.db.run(INDEXES);

    if (!fresh && version !== SCHEMA_VERSION) {
      this.db.run("DELETE FROM pr");
    }
    // Only written when it differs: an unconditional header write takes the
    // write lock on every open and collides with a concurrent process.
    if (version !== SCHEMA_VERSION) {
      this.db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }

  private hasColumn(table: string, column: string): boolean {
    return this.db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .some((c) => c.name === column);
  }

  close(): void {
    try {
      // Fold the WAL back into the database so the sidecars do not outlive the
      // process carrying a copy of the data.
      this.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // A checkpoint can legitimately fail if another process holds a read
      // snapshot. Losing it costs tidiness, not data.
    }
    this.db.close();
  }

  lastSync(provider: Provider): SyncRecord | null {
    const row = this.db
      .query<
        SyncRow,
        [string]
      >("SELECT * FROM sync WHERE provider = ? ORDER BY id DESC LIMIT 1")
      .get(provider);
    if (row === null) return null;
    // The file is untrusted, and `storedPrs` twelve lines down already treats it
    // that way. An unguarded parse here would brick launch with a bare
    // SyntaxError and no way to recover but deleting the database by hand.
    let repos: string[];
    try {
      const parsed: unknown = JSON.parse(row.repos);
      if (!Array.isArray(parsed) || !parsed.every((r) => typeof r === "string")) {
        return null;
      }
      repos = parsed;
    } catch {
      return null;
    }
    // The viewer is rendered as the first field of the header, so it crosses the
    // same boundary every other stored string does — `typeof` alone would let a
    // tampered row paint escape sequences.
    if (!isClean(row.viewer) || typeof row.at !== "string") return null;
    return {
      id: row.id,
      provider,
      at: row.at,
      viewer: row.viewer,
      repos,
      prCount: row.pr_count,
      baselineReset: row.baseline_reset === 1,
    };
  }

  /**
   * Every PR committed by the last sync, and how many rows were rejected.
   *
   * Rows that fail validation are dropped: the file is on disk and therefore
   * untrusted, and a stored `url` reaches both a spawned `open` and an OSC 8
   * escape sequence. The count is returned rather than swallowed — a silent drop
   * makes the next diff fabricate a `left` and then a `joined` for that PR.
   */
  storedPrs(provider: Provider): { prs: PullRequest[]; rejected: number } {
    const rows = this.db
      .query<{ payload: string }, [string]>("SELECT payload FROM pr WHERE provider = ?")
      .all(provider);
    const prs: PullRequest[] = [];
    let rejected = 0;
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload);
      } catch {
        rejected++;
        continue;
      }
      if (isPullRequest(parsed)) prs.push(parsed);
      else rejected++;
    }
    return { prs, rejected };
  }

  changesFor(syncId: number): Change[] {
    return this.db
      .query<
        { pr_id: string; kind: string; from_v: string | null; to_v: string | null },
        [number]
      >("SELECT pr_id, kind, from_v, to_v FROM change WHERE sync_id = ? ORDER BY rowid")
      .all(syncId)
      // Migration deliberately keeps history across schema versions, so an
      // obsolete kind is an expected input. An unvalidated one renders as
      // `[undefined]` and wins `headline` outright, hiding the real change.
      .filter((row) => isChangeKind(row.kind))
      .map((row) => ({
        prId: row.pr_id,
        kind: row.kind as ChangeKind,
        from: row.from_v,
        to: row.to_v,
      }));
  }

  /**
   * Everything the UI needs on launch, with no network call.
   *
   * Wrapped in a transaction so all three statements see one WAL snapshot: read
   * unsynchronised, a commit landing mid-sequence yields a sync record from one
   * sync paired with the rows of the next, and the diff then runs against a
   * baseline that has already moved.
   */
  read(provider: Provider): StoredState {
    return this.db.transaction((): StoredState => {
      const sync = this.lastSync(provider);
      if (sync === null) return { sync: null, prs: [], changes: [], incomplete: false };
      const { prs, rejected } = this.storedPrs(provider);
      // Rows were lost — to a schema drop, or to validation. The stored changes
      // describe a state we can no longer reproduce, so presenting them as this
      // sync's report would claim changes the list cannot show.
      const incomplete = rejected > 0 || prs.length !== sync.prCount;
      return {
        sync,
        prs,
        changes: incomplete ? [] : this.changesFor(sync.id),
        incomplete,
      };
    })();
  }

  /**
   * Commits a completed sync in one transaction: the sync row, the new current
   * state, and the changes against the previous state.
   *
   * The caller must not call this for a failed or partial scan. A partial result
   * committed as a baseline makes every later diff inherit the hole, so the
   * decision belongs at the call site where the failure list is known.
   */
  commit(input: {
    provider: Provider;
    viewer: string;
    repos: string[];
    prs: PullRequest[];
    changes: Change[];
    /** True when there was no previous state to diff against. */
    baselineReset: boolean;
    at?: Date;
  }): SyncRecord {
    const at = (input.at ?? new Date()).toISOString();

    const run = this.db.transaction(() => {
      this.db
        .query(
          "INSERT INTO sync (provider, at, viewer, repos, pr_count, baseline_reset) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.provider,
          at,
          input.viewer,
          JSON.stringify(input.repos),
          input.prs.length,
          input.baselineReset ? 1 : 0,
        );

      const syncId = this.db
        .query<{ id: number }, []>("SELECT last_insert_rowid() AS id")
        .get()!.id;

      // Scoped to this provider: the other provider's baseline is untouched, so a
      // failure on one side never disturbs the other's diff.
      this.db.query("DELETE FROM pr WHERE provider = ?").run(input.provider);
      const insertPr = this.db.query(
        "INSERT INTO pr (id, provider, synced, payload) VALUES (?, ?, ?, ?)",
      );
      for (const pr of input.prs) {
        insertPr.run(pr.id, input.provider, syncId, JSON.stringify(pr));
      }

      const insertChange = this.db.query(
        "INSERT OR REPLACE INTO change (sync_id, pr_id, kind, from_v, to_v) VALUES (?, ?, ?, ?, ?)",
      );
      for (const change of input.changes) {
        insertChange.run(syncId, change.prId, change.kind, change.from, change.to);
      }

      return syncId;
    });

    const syncId = run();
    return {
      id: syncId,
      provider: input.provider,
      at,
      viewer: input.viewer,
      repos: input.repos,
      prCount: input.prs.length,
      baselineReset: input.baselineReset,
    };
  }

  /** Syncs recorded, optionally for one provider. For diagnostics and tests. */
  syncCount(provider?: Provider): number {
    if (provider === undefined) {
      return this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM sync").get()!.n;
    }
    return this.db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM sync WHERE provider = ?")
      .get(provider)!.n;
  }
}
