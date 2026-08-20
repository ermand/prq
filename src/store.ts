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
import {
  isCensusPr,
  resolvePeople,
  toCount,
  toPrState,
  type CensusPr,
  type CensusReview,
  type PersonRule,
  type RepoCensus,
  type ReviewAct,
} from "./census";
import {
  isClean,
  isPullRequest,
  sanitize,
  safeUrl,
  type Provider,
  type PullRequest,
} from "./domain";

/** Bumped whenever the schema or the shape of a stored PR changes. */
export const SCHEMA_VERSION = 5;

/**
 * The oldest schema version whose stored `pr` payloads this build can still
 * read. v3 and v4 only *added* tables, and v5 only *added* columns, so a v2
 * database keeps its baseline and the next sync diffs against it instead of
 * resetting — dropping it would cost the driver a change report for nothing.
 */
const PAYLOAD_VERSION = 2;

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

CREATE TABLE IF NOT EXISTS census_pr (
  provider   TEXT    NOT NULL,
  repo       TEXT    NOT NULL,
  number     INTEGER NOT NULL,
  state      TEXT    NOT NULL,
  draft      INTEGER NOT NULL,
  title      TEXT    NOT NULL,
  url        TEXT,
  author     TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  merged_at  TEXT,
  closed_at  TEXT,
  additions  INTEGER NOT NULL,
  deletions  INTEGER NOT NULL,
  files      INTEGER NOT NULL,
  merged_by  TEXT    NOT NULL,
  PRIMARY KEY (provider, repo, number)
);

-- Deliberately not keyed on the reviewer: one reviewer acts repeatedly on one
-- pull request, and the sequence of acts is the interesting part. A plain rowid
-- table keeps insertion order, which is the provider's order.
CREATE TABLE IF NOT EXISTS census_review (
  provider TEXT    NOT NULL,
  repo     TEXT    NOT NULL,
  number   INTEGER NOT NULL,
  reviewer TEXT    NOT NULL,
  act      TEXT    NOT NULL,
  at       TEXT
);

-- One row per project, overwritten each census: when it last ran, and whether
-- what it wrote was whole.
CREATE TABLE IF NOT EXISTS census_run (
  provider  TEXT    NOT NULL,
  repo      TEXT    NOT NULL,
  at        TEXT    NOT NULL,
  prs       INTEGER NOT NULL,
  reviews   INTEGER NOT NULL,
  failed    TEXT,
  truncated INTEGER NOT NULL,
  PRIMARY KEY (provider, repo)
);

-- Derived, never authoritative: recomputed from the census tables after every
-- successful replace, so it can never drift from the rows it summarises.
CREATE TABLE IF NOT EXISTS contributor (
  provider   TEXT    NOT NULL,
  username   TEXT    NOT NULL,
  first_seen TEXT    NOT NULL,
  last_seen  TEXT    NOT NULL,
  prs        INTEGER NOT NULL,
  reviews    INTEGER NOT NULL,
  PRIMARY KEY (provider, username)
);

-- v4. The tracked project list, moved out of config.yaml: presence means
-- tracked, absence means neither scanned nor shown. Census rows outlive a row
-- here on purpose (see removeProject), so this table is the only authority on
-- what a page may display.
--
-- v5 added the active column. It means exactly one thing: an inactive project
-- is not fetched — sync and census skip it — and every read path stays blind to
-- the column. Untracked and inactive are therefore different states, which was
-- settled by driving them side by side: inactive left one contributor with his
-- one stored row, untracking left him with none.
CREATE TABLE IF NOT EXISTS project (
  provider TEXT NOT NULL,
  path     TEXT NOT NULL,
  added_at TEXT NOT NULL,
  active   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (provider, path)
);

-- Sparse by design: a row exists only once somebody is named or merged. Every
-- other identity the census sees still stands alone under provider:username,
-- which is the id the roster and its URLs already used — so materialising a
-- person moves nothing.
--
-- v5 added the active column, which hides somebody from the roster by default
-- and changes nothing else: their pull requests still count toward every
-- project's numbers, because the work is a matter of record and somebody
-- leaving does not un-write their code. Driven by hand; the alternative dropped
-- 11 real pull requests from a profile. Deliberately not folded into the bot
-- flag: a bot is a permanent property of an account, inactive is a decision.
CREATE TABLE IF NOT EXISTS person (
  id         TEXT NOT NULL PRIMARY KEY,
  label      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1
);

-- Which forge account belongs to which person. Keyed on the identity, so one
-- account can never be claimed by two people; a merge rewrites person_id.
CREATE TABLE IF NOT EXISTS person_alias (
  provider  TEXT NOT NULL,
  username  TEXT NOT NULL,
  person_id TEXT NOT NULL,
  PRIMARY KEY (provider, username)
);

-- Small key/value header rows. Holds the seed marker, which has to be a stored
-- fact rather than an inference: "import the config lists when the project
-- table is empty" means deleting your last project resurrects the whole config
-- on the next launch.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
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
CREATE INDEX IF NOT EXISTS census_pr_by_author ON census_pr(provider, author);
CREATE INDEX IF NOT EXISTS census_pr_by_state ON census_pr(provider, repo, state);
CREATE INDEX IF NOT EXISTS census_review_by_pr ON census_review(provider, repo, number);
CREATE INDEX IF NOT EXISTS census_review_by_reviewer ON census_review(provider, reviewer);
CREATE INDEX IF NOT EXISTS person_alias_by_person ON person_alias(person_id);
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

/** One census operation, as `census_run` remembers it. */
export interface CensusRun {
  provider: Provider;
  repo: string;
  at: Date;
  prs: number;
  reviews: number;
  /** Set when the project could not be read. Stored rows are then the old ones. */
  failed: string | null;
  /** True when paging hit its ceiling, so the stored rows are a prefix. */
  truncated: boolean;
}

/**
 * One forge identity, derived from the census tables.
 *
 * Per-provider, not per-person: this counts accounts, and which accounts belong
 * to one human is `person_alias`'s answer, applied at read time by
 * `resolvePeople` over `personRules`.
 */
export interface Contributor {
  provider: Provider;
  username: string;
  firstSeen: string;
  lastSeen: string;
  prs: number;
  reviews: number;
}

/** One tracked project: a row of the `project` table. */
export interface TrackedProject {
  provider: Provider;
  path: string;
  /** ISO 8601, from the caller's clock — the store never reads one. */
  addedAt: string;
  /**
   * False when the project has been marked inactive, which means it is not
   * fetched and nothing more. Its stored rows still count everywhere, so the
   * pages list it with the mark rather than hiding it — that is
   * `projectsByProvider`'s job, and the split between the two is the whole
   * mechanism.
   */
  active: boolean;
}

interface ProjectRow {
  provider: string;
  path: string;
  added_at: string;
  active: number;
}

interface PersonRow {
  id: string;
  label: string;
  active: number;
}

interface AliasRow {
  provider: string;
  username: string;
  person_id: string;
}

interface CensusPrRow {
  provider: string;
  repo: string;
  number: number;
  state: string;
  draft: number;
  title: string;
  url: string | null;
  author: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
  additions: number;
  deletions: number;
  files: number;
  merged_by: string;
}

interface CensusReviewRow {
  provider: string;
  repo: string;
  number: number;
  reviewer: string;
  act: string;
  at: string | null;
}

interface CensusRunRow {
  provider: string;
  repo: string;
  at: string;
  prs: number;
  reviews: number;
  failed: string | null;
  truncated: number;
}

interface ContributorRow {
  provider: string;
  username: string;
  first_seen: string;
  last_seen: string;
  prs: number;
  reviews: number;
}

/**
 * Any stored string, on the way out.
 *
 * SQLite is dynamically typed, so a NOT NULL TEXT column still hands back a blob
 * if something wrote one — and every field these guard reaches a terminal or an
 * OSC 8 escape. The file is on disk and therefore untrusted, exactly as
 * `storedPrs` already assumes.
 */
const text = (raw: unknown): string => (typeof raw === "string" ? sanitize(raw) : "");

const stamp = (raw: unknown): string | null =>
  typeof raw === "string" && raw !== "" ? sanitize(raw) : null;

/**
 * A stored activity mark, on the way out.
 *
 * Only an explicit 0 is inactive. Deliberately not the `=== 1` this file uses
 * for every other boolean column: those default to false, this one defaults to
 * true. The column carries DEFAULT 1, every row written before v5 reads as
 * active, and `resolvePeople` already spells the same rule — a missing flag must
 * not read as "hidden". Erring the other way would let one unreadable byte stop
 * a project being fetched, and since inactivity changes nothing a page renders,
 * that failure would leave no trace anywhere.
 */
const mark = (raw: unknown): boolean => raw !== 0;

const isProvider = (raw: unknown): raw is Provider => raw === "github" || raw === "gitlab";

/**
 * Stored acts are the domain spelling (`changes-requested`), not the provider's
 * (`CHANGES_REQUESTED`), so `toReviewAct` is the wrong direction here.
 */
const isAct = (raw: unknown): raw is ReviewAct =>
  raw === "approved" ||
  raw === "changes-requested" ||
  raw === "commented" ||
  raw === "dismissed";

const PROVIDERS: readonly Provider[] = ["github", "gitlab"];

/**
 * The two project-path shapes, re-expressed here rather than imported.
 *
 * `config.ts` owns the same two regexes for the same reason — a GitHub path is
 * interpolated into a search string, where a third segment or a space can inject
 * a qualifier and silently widen the scan, while a GitLab path is a GraphQL
 * variable and only has to catch typos. The store must not depend on the config
 * loader: a path now arrives from a keystroke, not from a file, and this is the
 * sink both routes end at. Two lines of duplicated regex is cheaper than the
 * store knowing what a config file is.
 */
const PROJECT_PATH: Record<Provider, RegExp> = {
  github: /^[\w.-]+\/[\w.-]+$/,
  gitlab: /^[\w.-]+(?:\/[\w.-]+)+$/,
};

const PROJECT_SHAPES: Record<Provider, string> = {
  github: "owner/name",
  gitlab: "group/project, nested as deeply as needed",
};

/**
 * A forge username, not a project path.
 *
 * Deliberately stricter than `PROJECT_PATH`: a path accepts `owner/repo`, so
 * validating an identity as a path would let a project path pose as a person and
 * claim nobody.
 */
const USERNAME = /^[^\s/]+$/;

/** Throws unless the path is one this provider could actually name. */
function checkPath(provider: Provider, path: string): void {
  if (!PROJECT_PATH[provider].test(path)) {
    throw new Error(
      `a ${provider} project must be ${PROJECT_SHAPES[provider]} — rejected: ` +
        JSON.stringify(path),
    );
  }
}

function checkUsername(provider: Provider, username: string): void {
  if (!USERNAME.test(username)) {
    throw new Error(
      `a ${provider} username carries no separator and no whitespace — rejected: ` +
        JSON.stringify(username),
    );
  }
}

/**
 * A display name, on the way in. Trimmed, sanitised, and never empty: the label
 * is the only thing distinguishing a named person from a bare login, and a blank
 * one would render as a person with no name at all.
 */
function checkedLabel(label: string): string {
  const clean = sanitize(label).trim();
  if (clean === "") throw new Error("a person's name cannot be blank");
  return clean;
}

/**
 * Splits `provider:username` — the id an unmerged identity has always had.
 *
 * Null for anything else, which is what a slug id (a config-seeded person) or a
 * merge target looks like.
 */
function identityOf(id: string): { provider: Provider; username: string } | null {
  const colon = id.indexOf(":");
  if (colon === -1) return null;
  const provider = id.slice(0, colon);
  const username = id.slice(colon + 1);
  if (!isProvider(provider) || username === "" || !USERNAME.test(username)) return null;
  return { provider, username };
}

/** The login half of an id, which is the label a never-named person falls back to. */
const loginOf = (id: string): string => identityOf(id)?.username ?? id;

/**
 * The seed marker. Its presence, not the emptiness of `project`, is what stops a
 * second import: "import when the table is empty" was driven by hand and makes
 * deleting your last project resurrect the whole config file on the next launch.
 */
const SEED_KEY = "tracking.seeded";

/**
 * An optional-equality WHERE clause. Column names are literals from the call
 * sites below, never caller input; only the values are ever bound.
 */
function clauses(
  fields: [column: string, value: string | undefined][],
): { where: string; args: string[] } {
  const parts: string[] = [];
  const args: string[] = [];
  for (const [column, value] of fields) {
    if (value === undefined) continue;
    parts.push(`${column} = ?`);
    args.push(value);
  }
  return { where: parts.length === 0 ? "" : ` WHERE ${parts.join(" AND ")}`, args };
}

/**
 * Rebuilds `contributor` from the census tables.
 *
 * One statement over a union of observations rather than a pass in TypeScript:
 * the largest configured repo alone holds 3309 pull requests, and identities span
 * repos, so a partial recompute would need every repo's rows in memory anyway.
 *
 * A review act bounds the identity's window by its own timestamp where it has
 * one, and otherwise by the reviewed pull request's — GitLab's `approvedBy`
 * carries no time, and the pull request it sits on is the tightest bound left.
 */
const RECOMPUTE_CONTRIBUTORS = `
INSERT INTO contributor (provider, username, first_seen, last_seen, prs, reviews)
SELECT provider,
       username,
       coalesce(min(low), ''),
       coalesce(max(high), ''),
       sum(is_pr),
       sum(is_review)
  FROM (
       SELECT provider, author AS username, created_at AS low, updated_at AS high,
              1 AS is_pr, 0 AS is_review
         FROM census_pr
        WHERE author <> ''
       UNION ALL
       SELECT r.provider, r.reviewer AS username,
              coalesce(r.at, p.created_at) AS low,
              coalesce(r.at, p.updated_at) AS high,
              0 AS is_pr, 1 AS is_review
         FROM census_review r
         LEFT JOIN census_pr p
           ON p.provider = r.provider AND p.repo = r.repo AND p.number = r.number
        WHERE r.reviewer <> ''
       )
 GROUP BY provider, username
`;

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

    // v4 predates the activity mark. Additive and defaulted, so a v4 file keeps
    // every row and every one of them reads as active — the only safe reading,
    // since the mark is a human decision and no migration can infer one. The
    // `hasColumn` guard is what lets this run after `TABLES` has already created
    // the tables from scratch for a v3 file.
    if (!fresh && version < 5) {
      for (const table of ["project", "person"]) {
        if (!this.hasColumn(table, "active")) {
          this.db.run(`ALTER TABLE ${table} ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);
        }
      }
    }

    this.db.run(INDEXES);

    // Scoped to versions whose payload shape this build cannot read, not to any
    // version move: v3 added tables and left the payload alone, so a v2 baseline
    // is still diffable and dropping it would cost a change report for nothing.
    if (!fresh && version < PAYLOAD_VERSION) {
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

  /**
   * Replaces one project's census in a single transaction.
   *
   * A full replace scoped to `(provider, repo)` rather than an upsert: a pull
   * request the walk no longer sees — squashed history, a transferred repo — would
   * otherwise sit in the dashboard forever. Another project's rows are never
   * touched, so one failing repo cannot cost the others their history.
   */
  writeCensus(census: RepoCensus, at: Date): void {
    const run = this.db.transaction(() => {
      this.db
        .query(
          "INSERT OR REPLACE INTO census_run (provider, repo, at, prs, reviews, failed, truncated) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          census.provider,
          census.repo,
          at.toISOString(),
          census.prs.length,
          census.reviews.length,
          census.failed,
          census.truncated ? 1 : 0,
        );

      // A failure records the attempt and stops. Replacing good history with a
      // partial read is the same mistake `commit` refuses to make for a partial
      // scan: the hole would be inherited by every later reading of the repo.
      if (census.failed !== null) return;

      this.db
        .query("DELETE FROM census_pr WHERE provider = ? AND repo = ?")
        .run(census.provider, census.repo);
      this.db
        .query("DELETE FROM census_review WHERE provider = ? AND repo = ?")
        .run(census.provider, census.repo);

      // Prepared once and reused: 3309 rows land in one call, and a fresh
      // prepare per row is the whole cost at that size.
      const insertPr = this.db.query(
        "INSERT INTO census_pr (provider, repo, number, state, draft, title, url, author, created_at, updated_at, merged_at, closed_at, additions, deletions, files, merged_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const pr of census.prs) {
        insertPr.run(
          pr.provider,
          pr.repo,
          pr.number,
          pr.state,
          pr.draft ? 1 : 0,
          pr.title,
          pr.url,
          pr.author,
          pr.createdAt,
          pr.updatedAt,
          pr.mergedAt,
          pr.closedAt,
          pr.additions,
          pr.deletions,
          pr.files,
          pr.mergedBy,
        );
      }

      const insertReview = this.db.query(
        "INSERT INTO census_review (provider, repo, number, reviewer, act, at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const review of census.reviews) {
        insertReview.run(
          review.provider,
          review.repo,
          review.number,
          review.reviewer,
          review.act,
          review.at,
        );
      }

      this.db.run("DELETE FROM contributor");
      this.db.run(RECOMPUTE_CONTRIBUTORS);
    });
    run();
  }

  /**
   * Census rows, ordered by project and number.
   *
   * Rows that cannot be a `CensusPr` are dropped rather than repaired: the same
   * rule `storedPrs` follows, for the same reason — a stored `url` reaches both a
   * spawned `open` and an OSC 8 escape sequence.
   */
  censusPrs(
    filter: { provider?: Provider; repo?: string; author?: string } = {},
  ): CensusPr[] {
    const { where, args } = clauses([
      ["provider", filter.provider],
      ["repo", filter.repo],
      ["author", filter.author],
    ]);
    return this.db
      .query<
        CensusPrRow,
        string[]
      >(`SELECT * FROM census_pr${where} ORDER BY provider, repo, number`)
      .all(...args)
      .map((row) => ({
        provider: row.provider as Provider,
        repo: text(row.repo),
        number: row.number,
        state: toPrState(row.state),
        draft: row.draft === 1,
        title: text(row.title),
        url: safeUrl(row.url),
        author: text(row.author),
        createdAt: text(row.created_at),
        updatedAt: text(row.updated_at),
        mergedAt: stamp(row.merged_at),
        closedAt: stamp(row.closed_at),
        additions: toCount(row.additions),
        deletions: toCount(row.deletions),
        files: toCount(row.files),
        mergedBy: text(row.merged_by),
      }))
      .filter(isCensusPr);
  }

  /** Review acts, in the order the provider reported them. */
  censusReviews(
    filter: { provider?: Provider; repo?: string; reviewer?: string } = {},
  ): CensusReview[] {
    const { where, args } = clauses([
      ["provider", filter.provider],
      ["repo", filter.repo],
      ["reviewer", filter.reviewer],
    ]);
    return this.db
      .query<CensusReviewRow, string[]>(`SELECT * FROM census_review${where} ORDER BY rowid`)
      .all(...args)
      .flatMap((row) =>
        isProvider(row.provider) && isAct(row.act) && typeof row.number === "number"
          ? [
              {
                provider: row.provider,
                repo: text(row.repo),
                number: row.number,
                reviewer: text(row.reviewer),
                act: row.act,
                at: stamp(row.at),
              },
            ]
          : [],
      );
  }

  /** When each project was last censused, and whether the result was whole. */
  censusRuns(): CensusRun[] {
    return this.db
      .query<CensusRunRow, []>("SELECT * FROM census_run ORDER BY provider, repo")
      .all()
      .flatMap((row) => {
        const at = new Date(text(row.at));
        // An unreadable timestamp would reach `toISOString` in the header and
        // throw there instead of here.
        if (!isProvider(row.provider) || Number.isNaN(at.getTime())) return [];
        return [
          {
            provider: row.provider,
            repo: text(row.repo),
            at,
            prs: toCount(row.prs),
            reviews: toCount(row.reviews),
            failed: row.failed === null ? null : text(row.failed),
            truncated: row.truncated === 1,
          },
        ];
      });
  }

  contributors(): Contributor[] {
    return this.db
      .query<ContributorRow, []>("SELECT * FROM contributor ORDER BY provider, username")
      .all()
      .flatMap((row) =>
        isProvider(row.provider)
          ? [
              {
                provider: row.provider,
                username: text(row.username),
                firstSeen: text(row.first_seen),
                lastSeen: text(row.last_seen),
                prs: toCount(row.prs),
                reviews: toCount(row.reviews),
              },
            ]
          : [],
      );
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

  /**
   * Every tracked project, active or not, ordered as the projects page shows
   * them. The mark comes out with the row rather than filtering it: an inactive
   * project's stored rows still count everywhere, so hiding the project would
   * hide history that the pages go on displaying.
   */
  projects(): TrackedProject[] {
    return this.db
      .query<ProjectRow, []>("SELECT * FROM project ORDER BY provider, path")
      .all()
      .flatMap((row) =>
        isProvider(row.provider)
          ? [
              {
                provider: row.provider,
                path: text(row.path),
                addedAt: text(row.added_at),
                active: mark(row.active),
              },
            ]
          : [],
      );
  }

  /**
   * The **active** tracked list, in the shape `performSync` and `performCensus`
   * take, so the database drops straight into the place the config lists used to
   * fill.
   *
   * Active-only is the entire behavioural difference an inactive project makes:
   * this is the one list a fetch consumes, so dropping a project from it stops
   * the fetch and touches nothing else. Every read path — `projects`,
   * `censusPrs`, `purgeUntracked` — stays blind to the mark on purpose.
   */
  projectsByProvider(): Record<Provider, string[]> {
    const by: Record<Provider, string[]> = { github: [], gitlab: [] };
    for (const project of this.projects()) {
      if (project.active) by[project.provider].push(project.path);
    }
    return by;
  }

  /**
   * Tracks a project. False when it was already tracked — a no-op, not an error,
   * because the caller is a keystroke and a duplicate is a slip.
   *
   * Any census rows it left behind on a previous removal are still on disk, so a
   * re-add restores the history immediately: the reads filter on this table, not
   * on the census tables. That is worth having — one project's census measured
   * 2m21s.
   */
  addProject(provider: Provider, path: string, at: Date): boolean {
    checkPath(provider, path);
    const run = this.db.transaction(() => {
      const existing = this.db
        .query<
          { n: number },
          [string, string]
        >("SELECT count(*) AS n FROM project WHERE provider = ? AND path = ?")
        .get(provider, path)!.n;
      if (existing > 0) return false;
      this.db
        .query("INSERT INTO project (provider, path, added_at) VALUES (?, ?, ?)")
        .run(provider, path, at.toISOString());
      return true;
    });
    return run();
  }

  /**
   * Untracks a project and **keeps its census rows**. False when it was not
   * tracked.
   *
   * Deleting the rows would make a mis-click cost a full re-census, and every
   * read already filters on the tracked set, so the rows are invisible until the
   * project comes back. `purgeUntracked` is the explicit way to reclaim the
   * space.
   */
  removeProject(provider: Provider, path: string): boolean {
    const run = this.db.transaction(() => {
      const existing = this.db
        .query<
          { n: number },
          [string, string]
        >("SELECT count(*) AS n FROM project WHERE provider = ? AND path = ?")
        .get(provider, path)!.n;
      if (existing === 0) return false;
      this.db.query("DELETE FROM project WHERE provider = ? AND path = ?").run(provider, path);
      return true;
    });
    return run();
  }

  /**
   * Marks a tracked project active or inactive. False when it is not tracked at
   * all, which is a different state and not one this can reach: untracking hides
   * a project's history, inactivity keeps it. Driven side by side — marking
   * inactive left a contributor's one stored pull request on his profile, and
   * untracking the same project left him with nothing.
   *
   * Census rows are never touched. The mark reaches exactly one caller,
   * `projectsByProvider`, and therefore does exactly one thing: the project
   * stops being fetched.
   */
  setProjectActive(provider: Provider, path: string, active: boolean): boolean {
    const run = this.db.transaction(() => {
      const existing = this.db
        .query<
          { n: number },
          [string, string]
        >("SELECT count(*) AS n FROM project WHERE provider = ? AND path = ?")
        .get(provider, path)!.n;
      if (existing === 0) return false;
      this.db
        .query("UPDATE project SET active = ? WHERE provider = ? AND path = ?")
        .run(active ? 1 : 0, provider, path);
      return true;
    });
    return run();
  }

  /**
   * Drops the census history of every untracked project and returns how many
   * rows went. The counterpart to `removeProject` keeping them: this is the only
   * way to reclaim the space, and it is never implicit.
   *
   * Counts `census_pr` and `census_review` — the history itself. The matching
   * `census_run` rows go too, being a record of a scan whose rows no longer
   * exist, but they are metadata and not part of the count.
   *
   * Deliberately blind to `active`: an inactive project is *tracked*, so its
   * rows are not orphans and must never be purged. The `project` row's presence
   * is the only test, exactly as it was before the mark existed — an inactive
   * project is one nobody fetches, not one whose history is being discarded.
   */
  purgeUntracked(): number {
    const untracked = (table: string) =>
      `NOT EXISTS (SELECT 1 FROM project p WHERE p.provider = ${table}.provider AND p.path = ${table}.repo)`;
    const run = this.db.transaction(() => {
      // Counted before the delete rather than read back from `changes()`: the
      // count is the caller's receipt and must not depend on the driver
      // reporting a row count for a multi-statement transaction.
      const doomed = this.db
        .query<{ n: number }, []>(
          `SELECT (SELECT count(*) FROM census_pr WHERE ${untracked("census_pr")})
                + (SELECT count(*) FROM census_review WHERE ${untracked("census_review")}) AS n`,
        )
        .get()!.n;
      this.db.run(`DELETE FROM census_pr WHERE ${untracked("census_pr")}`);
      this.db.run(`DELETE FROM census_review WHERE ${untracked("census_review")}`);
      // Unconditional, even when the count is zero: a project whose census
      // failed has a run row and no history, and leaving it behind would keep an
      // untracked project's last-scanned time on the page.
      this.db.run(`DELETE FROM census_run WHERE ${untracked("census_run")}`);
      // `contributor` is derived, so it has to be rebuilt from what is left or
      // it would keep counting rows that no longer exist.
      if (doomed > 0) {
        this.db.run("DELETE FROM contributor");
        this.db.run(RECOMPUTE_CONTRIBUTORS);
      }
      return doomed;
    });
    return run();
  }

  /**
   * Every stored person, as rules `resolvePeople` can apply.
   *
   * The id is always set, which is the whole point: a rule without one derives
   * its id from its label, so a rename would change the id and orphan every URL
   * pointing at the person. A person with no aliases left is still returned —
   * otherwise a name somebody typed would silently vanish from the roster.
   *
   * The activity mark rides along with each rule. It only decides who the roster
   * shows by default; every count is computed from the census rows regardless,
   * because an inactive person's pull requests are a matter of record.
   */
  personRules(): PersonRule[] {
    const persons = this.db
      .query<PersonRow, []>("SELECT id, label, active FROM person ORDER BY id")
      .all();
    const aliases = this.db
      .query<
        AliasRow,
        []
      >("SELECT provider, username, person_id FROM person_alias ORDER BY provider, username")
      .all();

    const owned = new Map<string, { provider: Provider; username: string }[]>();
    for (const row of aliases) {
      if (!isProvider(row.provider)) continue;
      const id = text(row.person_id);
      const list = owned.get(id);
      const alias = { provider: row.provider, username: text(row.username) };
      if (list === undefined) owned.set(id, [alias]);
      else list.push(alias);
    }

    const rules: PersonRule[] = [];
    for (const person of persons) {
      const id = text(person.id);
      rules.push({
        id,
        label: text(person.label),
        aliases: owned.get(id) ?? [],
        active: mark(person.active),
      });
      owned.delete(id);
    }
    // Alias rows whose person row is missing cannot happen through this API, but
    // the file is untrusted and a half-applied merge is worse than a nameless
    // one: it would show one human as two. Honour the grouping the file records,
    // under the login the person would fall back to anyway.
    for (const [id, group] of owned) {
      // No person row means no stored opinion, and no opinion means active.
      rules.push({ id, label: loginOf(id), aliases: group, active: true });
    }
    return rules;
  }

  /**
   * Names a person, materialising the row on write.
   *
   * The alias row is materialised with it, and that was a bug found by driving
   * the prototype: accounts were derived from *visible* census rows, so renaming
   * somebody and then untracking their only project left "Kristi Aziu — no
   * accounts" on the roster, a name attached to nothing. Anchoring the account
   * here also makes the row self-contained for a later merge.
   */
  renamePerson(id: string, label: string, at: Date): void {
    if (id === "") throw new Error("a person needs an id to be renamed");
    const clean = checkedLabel(label);
    const iso = at.toISOString();
    const identity = identityOf(id);
    const run = this.db.transaction(() => {
      this.db
        .query(
          "INSERT INTO person (id, label, updated_at) VALUES (?, ?, ?)" +
            " ON CONFLICT(id) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at",
        )
        .run(id, clean, iso);
      // Only an unmerged identity's id names an account. A slug id — a
      // config-seeded person, or a merge target — claims nothing by itself.
      if (identity === null) return;
      // OR IGNORE, not an upsert: if another person already claims this account,
      // that claim wins. A rename is not a merge and must not steal an alias.
      this.db
        .query(
          "INSERT OR IGNORE INTO person_alias (provider, username, person_id) VALUES (?, ?, ?)",
        )
        .run(identity.provider, identity.username, id);
    });
    run();
  }

  /**
   * Marks a person active or inactive, materialising the row on write exactly as
   * `renamePerson` does — and for the same reason. The roster offers
   * census-derived identities, so the common case is an identity nobody has ever
   * named: without materialising it there is nowhere to put the mark, and
   * without the alias row beside it the mark would detach from the account the
   * moment the person is merged or their last project untracked.
   *
   * An existing label is left alone. The conflict clause deliberately does not
   * touch it: this is not a rename, and a person already named must not be
   * reduced to their login by being marked inactive. A row being created falls
   * back to the login, which is what the roster would render anyway.
   *
   * Inactivity hides somebody from the roster by default and does nothing else.
   * Their pull requests still count toward every project's numbers — driven by
   * hand, and the alternative erased 11 real pull requests from a profile the
   * moment a dormant repository was archived. There is also no way to *clear*
   * the mark implicitly: a later census that sees the identity again leaves it
   * standing, because a cron job must not overturn a human decision.
   */
  setPersonActive(id: string, active: boolean, at: Date): void {
    if (id === "") throw new Error("a person needs an id to be marked");
    const iso = at.toISOString();
    const identity = identityOf(id);
    const run = this.db.transaction(() => {
      this.db
        .query(
          "INSERT INTO person (id, label, updated_at, active) VALUES (?, ?, ?, ?)" +
            " ON CONFLICT(id) DO UPDATE SET active = excluded.active, updated_at = excluded.updated_at",
        )
        .run(id, loginOf(id), iso, active ? 1 : 0);
      // Only an unmerged identity's id names an account. A slug id — a
      // config-seeded person, or a merge target — claims nothing by itself.
      if (identity === null) return;
      // OR IGNORE, as in `renamePerson`: if another person already claims this
      // account, that claim wins. Marking somebody is not a merge.
      this.db
        .query(
          "INSERT OR IGNORE INTO person_alias (provider, username, person_id) VALUES (?, ?, ?)",
        )
        .run(identity.provider, identity.username, id);
    });
    run();
  }

  /**
   * Folds one person into another. The target keeps its own id and label, so
   * every URL pointing at it still resolves. False when the two are the same, or
   * when `fromId` names nothing this store could move.
   */
  mergePersons(fromId: string, intoId: string, at: Date): boolean {
    if (fromId === intoId || fromId === "" || intoId === "") return false;
    const from = identityOf(fromId);
    const iso = at.toISOString();
    const run = this.db.transaction(() => {
      const owned = this.db
        .query<
          { n: number },
          [string]
        >("SELECT count(*) AS n FROM person_alias WHERE person_id = ?")
        .get(fromId)!.n;
      const named = this.db
        .query<{ n: number }, [string]>("SELECT count(*) AS n FROM person WHERE id = ?")
        .get(fromId)!.n;
      // Nothing stored, and not an identity id either: there is no person here
      // to fold, and inventing one would attach an alias to a name nobody uses.
      if (owned === 0 && named === 0 && from === null) return false;

      if (owned > 0) {
        this.db
          .query("UPDATE person_alias SET person_id = ? WHERE person_id = ?")
          .run(intoId, fromId);
      } else if (from !== null) {
        // An identity standing alone owns no alias row, so the move would have
        // nothing to rewrite. Give it one. The upsert covers the case the roster
        // cannot actually offer — the account already claimed by a third person —
        // and keeps the merge total rather than half-applied.
        this.db
          .query(
            "INSERT INTO person_alias (provider, username, person_id) VALUES (?, ?, ?)" +
              " ON CONFLICT(provider, username) DO UPDATE SET person_id = excluded.person_id",
          )
          .run(from.provider, from.username, intoId);
      }

      // The target must exist as a row now: its label would otherwise fall back
      // to a login that may no longer be one of its accounts. An existing row
      // keeps the label it already has — a merge does not rename anybody.
      this.db
        .query("INSERT OR IGNORE INTO person (id, label, updated_at) VALUES (?, ?, ?)")
        .run(intoId, loginOf(intoId), iso);

      // And the target's *own* account is anchored too, exactly as `renamePerson`
      // does. Without this, merging into an identity that had never been named
      // produced two people sharing one id: `resolvePeople` saw a rule holding
      // only the moved alias, then the target's own contributor key fell through
      // unclaimed and was pushed a second time. One human, listed twice, with the
      // counts split between the halves.
      const into = identityOf(intoId);
      if (into !== null) {
        this.db
          .query(
            "INSERT INTO person_alias (provider, username, person_id) VALUES (?, ?, ?)" +
              " ON CONFLICT(provider, username) DO UPDATE SET person_id = excluded.person_id",
          )
          .run(into.provider, into.username, intoId);
      }

      this.db.query("DELETE FROM person WHERE id = ?").run(fromId);
      return true;
    });
    return run();
  }

  /**
   * Un-claims one account, so it stands alone under its own identity again.
   * False when no alias row claimed it. The person it left keeps its row: a name
   * with nothing under it is still a name somebody typed.
   */
  splitAlias(provider: Provider, username: string): boolean {
    checkUsername(provider, username);
    const run = this.db.transaction(() => {
      const existing = this.db
        .query<
          { n: number },
          [string, string]
        >("SELECT count(*) AS n FROM person_alias WHERE provider = ? AND username = ?")
        .get(provider, username)!.n;
      if (existing === 0) return false;
      this.db
        .query("DELETE FROM person_alias WHERE provider = ? AND username = ?")
        .run(provider, username);
      return true;
    });
    return run();
  }

  /** True once the config's lists have been imported into this database. */
  isSeeded(): boolean {
    return (
      this.db
        .query<{ n: number }, [string]>("SELECT count(*) AS n FROM meta WHERE key = ?")
        .get(SEED_KEY)!.n > 0
    );
  }

  /**
   * Imports project and person lists once, and records that it happened. False
   * when this database was already seeded, in which case nothing is written.
   *
   * Plain arguments, not a `Config`: the store does not know what a config file
   * is. The marker is why this is a one-shot — keyed on "the `project` table is
   * empty" instead, deleting your last project resurrects the whole config file
   * on the next launch. That was found by driving it by hand.
   *
   * Person ids come from `resolvePeople` over the same rules, so a seeded person
   * gets exactly the id the previous, config-derived build gave them and no
   * bookmarked profile URL moves. A rule that already carries the mark keeps it:
   * an import is not a decision, and silently activating somebody a file says is
   * inactive is the same auto-reactivation a census is forbidden to do. Projects
   * arrive active — a config file has no way to say otherwise.
   */
  seedTracking(
    projects: Record<Provider, string[]>,
    people: PersonRule[],
    at: Date,
  ): boolean {
    const iso = at.toISOString();
    const tracked: TrackedProject[] = [];
    for (const provider of PROVIDERS) {
      for (const path of projects[provider] ?? []) {
        checkPath(provider, path);
        tracked.push({ provider, path, addedAt: iso, active: true });
      }
    }
    // Resolved outside the transaction: it throws on a blank label, and a throw
    // mid-transaction would leave the marker unset with rows already inserted.
    const seeded = resolvePeople([], people).people.map((person) => ({
      id: person.id,
      label: checkedLabel(person.label),
      aliases: person.aliases.map((alias) => {
        checkUsername(alias.provider, alias.username);
        return alias;
      }),
      active: person.active,
    }));

    const run = this.db.transaction(() => {
      if (this.isSeeded()) return false;

      // Prepared once and reused: a seed is a loop, and the configs this was
      // driven against list every project a team has.
      const insertProject = this.db.query(
        "INSERT OR IGNORE INTO project (provider, path, added_at, active) VALUES (?, ?, ?, ?)",
      );
      for (const project of tracked) {
        insertProject.run(
          project.provider,
          project.path,
          project.addedAt,
          project.active ? 1 : 0,
        );
      }

      const insertPerson = this.db.query(
        "INSERT OR IGNORE INTO person (id, label, updated_at, active) VALUES (?, ?, ?, ?)",
      );
      const insertAlias = this.db.query(
        "INSERT OR IGNORE INTO person_alias (provider, username, person_id) VALUES (?, ?, ?)",
      );
      for (const person of seeded) {
        insertPerson.run(person.id, person.label, iso, person.active ? 1 : 0);
        for (const alias of person.aliases) {
          insertAlias.run(alias.provider, alias.username, person.id);
        }
      }

      this.db.query("INSERT INTO meta (key, value) VALUES (?, ?)").run(SEED_KEY, iso);
      return true;
    });
    return run();
  }
}
