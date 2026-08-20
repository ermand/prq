/**
 * PROTOTYPE — throwaway. Run it with `bun run prototype:tracking`.
 *
 * ## The question
 *
 * Project lists and person names are moving out of `~/.config/prq/config.yaml`
 * and into the database, with CRUD over both. The rendering is not the hard part;
 * the state rules are. Specifically:
 *
 *   1. Config currently *is* the truth. Once the database is the truth, what does
 *      a config file that still lists projects mean? Is it a seed, and if it is a
 *      seed read at every launch, does deleting a project bring it back?
 *   2. Removing a project: its census history is already on disk. Delete it,
 *      orphan it, or hide it? Whatever the answer, the projects page and the
 *      people page must not disagree about it — they just did, and it took a
 *      measurement to notice.
 *   3. A person is currently *derived* from the identities the census saw plus
 *      the config's alias rules. If a name can be edited, a person becomes a
 *      stored thing with an id. What is that id, and does it survive a rename, a
 *      merge, and a later census that sees the same login again?
 *
 * This module is the part worth keeping: a pure reducer, no I/O, no clock. The
 * TUI beside it is the throwaway shell. If a rule here survives being driven by
 * hand, it gets lifted into the real `src/tracking.ts`.
 */

export type Provider = "github" | "gitlab";

export interface ProjectRow {
  provider: Provider;
  path: string;
}

export interface PersonRow {
  id: string;
  label: string;
}

export interface AliasRow {
  provider: Provider;
  username: string;
  personId: string;
}

/** A census observation. Stands in for `census_pr` at one row per PR. */
export interface Observation {
  provider: Provider;
  path: string;
  author: string;
}

export interface State {
  /** Presence means tracked. Absence means not scanned and not shown. */
  projects: ProjectRow[];
  /** Sparse: a row exists only once somebody is named or merged. */
  persons: PersonRow[];
  aliases: AliasRow[];
  /** Census rows, which outlive the project being untracked. */
  observations: Observation[];
  /**
   * The migration marker. Without it, "import when the table is empty" means
   * deleting your last project resurrects the whole config on next launch.
   */
  seeded: boolean;
  /** What is still sitting in config.yaml, whether or not it is honoured. */
  configProjects: ProjectRow[];
  log: string[];
}

export type Action =
  | { kind: "launch" }
  | { kind: "add-project"; provider: Provider; path: string }
  | { kind: "remove-project"; provider: Provider; path: string }
  | { kind: "census"; observations: Observation[] }
  | { kind: "rename"; personId: string; label: string }
  | { kind: "merge"; fromId: string; intoId: string }
  | { kind: "split"; provider: Provider; username: string }
  | { kind: "purge-untracked" }
  | { kind: "edit-config"; projects: ProjectRow[] };

export function initial(configProjects: ProjectRow[]): State {
  return {
    projects: [],
    persons: [],
    aliases: [],
    observations: [],
    seeded: false,
    configProjects,
    log: ["fresh database; config.yaml still holds the project lists"],
  };
}

const key = (p: Provider, s: string) => `${p}:${s}`;

/** Tracked-ness is a set membership test, done in one place. */
function isTracked(state: State, provider: Provider, path: string): boolean {
  return state.projects.some((p) => p.provider === provider && p.path === path);
}

/**
 * The person an identity belongs to. An identity with no alias row stands alone
 * under its own key — which is exactly what the census-derived roster does today,
 * so an un-renamed person keeps the same id it always had.
 */
export function personIdOf(state: State, provider: Provider, username: string): string {
  const alias = state.aliases.find((a) => a.provider === provider && a.username === username);
  return alias?.personId ?? key(provider, username);
}

export function labelOf(state: State, personId: string): string {
  const person = state.persons.find((p) => p.id === personId);
  if (person) return person.label;
  // Unnamed: fall back to the login, which is what the roster shows now.
  const colon = personId.indexOf(":");
  return colon === -1 ? personId : personId.slice(colon + 1);
}

export function reduce(state: State, action: Action): State {
  const log = (message: string): string[] => [message, ...state.log].slice(0, 8);

  switch (action.kind) {
    case "launch": {
      // The rule under test. Seed once, record that it happened, and never look
      // at the config's project lists again.
      if (state.seeded) {
        const stillThere = state.configProjects.length > 0;
        return {
          ...state,
          log: log(
            stillThere
              ? `launch: config still lists ${state.configProjects.length} project(s) — IGNORED, database is the truth`
              : "launch: database is the truth",
          ),
        };
      }
      return {
        ...state,
        projects: [...state.configProjects],
        seeded: true,
        log: log(`launch: imported ${state.configProjects.length} project(s) from config.yaml, once`),
      };
    }

    case "add-project": {
      if (isTracked(state, action.provider, action.path)) {
        return { ...state, log: log(`add: ${action.path} already tracked`) };
      }
      // Re-adding something previously removed: its observations are still here,
      // so the history reappears with no census needed.
      const recovered = state.observations.filter(
        (o) => o.provider === action.provider && o.path === action.path,
      ).length;
      return {
        ...state,
        projects: [...state.projects, { provider: action.provider, path: action.path }],
        log: log(
          recovered > 0
            ? `add: ${action.path} — ${recovered} stored row(s) came back, no census needed`
            : `add: ${action.path} — no history yet, run a census`,
        ),
      };
    }

    case "remove-project": {
      if (!isTracked(state, action.provider, action.path)) {
        return { ...state, log: log(`remove: ${action.path} was not tracked`) };
      }
      // Observations are deliberately KEPT. Deleting them would make a mis-click
      // cost a two-minute re-census, and every read already filters on tracked.
      return {
        ...state,
        projects: state.projects.filter(
          (p) => !(p.provider === action.provider && p.path === action.path),
        ),
        log: log(`remove: ${action.path} untracked; its rows kept but hidden`),
      };
    }

    case "census": {
      // Only tracked projects are ever fetched, so an untracked project cannot
      // acquire new rows.
      const accepted = action.observations.filter((o) => isTracked(state, o.provider, o.path));
      const rejected = action.observations.length - accepted.length;
      const fresh = accepted.filter(
        (o) =>
          !state.observations.some(
            (e) => e.provider === o.provider && e.path === o.path && e.author === o.author,
          ),
      );
      return {
        ...state,
        observations: [...state.observations, ...fresh],
        log: log(
          `census: +${fresh.length} row(s)` +
            (rejected > 0 ? `, ${rejected} skipped (untracked)` : ""),
        ),
      };
    }

    case "rename": {
      // Materialise on write. A person row exists only once somebody names it,
      // and the id is the one the roster already used, so nothing moves.
      const existing = state.persons.find((p) => p.id === action.personId);
      const persons = existing
        ? state.persons.map((p) => (p.id === action.personId ? { ...p, label: action.label } : p))
        : [...state.persons, { id: action.personId, label: action.label }];

      // The alias row is materialised too, and this was a bug found by driving
      // it: accounts were derived from *visible* observations, so renaming
      // somebody and then untracking their only project left "Kristi Aziu —
      // no accounts" on the roster. A name attached to nothing. Anchoring the
      // account here also makes the row self-contained for a later merge.
      const colon = action.personId.indexOf(":");
      const claimed =
        colon === -1
          ? null
          : {
              provider: action.personId.slice(0, colon) as Provider,
              username: action.personId.slice(colon + 1),
            };
      const hasAlias =
        claimed !== null &&
        state.aliases.some(
          (a) => a.provider === claimed.provider && a.username === claimed.username,
        );
      const aliases =
        claimed === null || hasAlias
          ? state.aliases
          : [...state.aliases, { ...claimed, personId: action.personId }];

      return {
        ...state,
        persons,
        aliases,
        log: log(`rename: ${action.personId} is now "${action.label}"`),
      };
    }

    case "merge": {
      if (action.fromId === action.intoId) {
        return { ...state, log: log("merge: refused, same person") };
      }
      // Every alias of `from` moves to `into`. Identities with no alias row have
      // to gain one first, or the move has nothing to rewrite.
      const moved: AliasRow[] = [];
      for (const id of [action.fromId]) {
        const owned = state.aliases.filter((a) => a.personId === id);
        if (owned.length > 0) {
          moved.push(...owned.map((a) => ({ ...a, personId: action.intoId })));
        } else {
          const colon = id.indexOf(":");
          if (colon !== -1) {
            moved.push({
              provider: id.slice(0, colon) as Provider,
              username: id.slice(colon + 1),
              personId: action.intoId,
            });
          }
        }
      }
      const untouched = state.aliases.filter((a) => a.personId !== action.fromId);
      // `into` must exist as a row now, or its label would fall back to a login
      // that may not even be one of its aliases any more.
      const persons = state.persons.some((p) => p.id === action.intoId)
        ? state.persons
        : [...state.persons, { id: action.intoId, label: labelOf(state, action.intoId) }];
      return {
        ...state,
        aliases: [...untouched, ...moved],
        persons: persons.filter((p) => p.id !== action.fromId),
        log: log(`merge: ${action.fromId} folded into ${action.intoId}`),
      };
    }

    case "split": {
      const alias = state.aliases.find(
        (a) => a.provider === action.provider && a.username === action.username,
      );
      if (!alias) {
        return { ...state, log: log(`split: ${action.username} is already alone`) };
      }
      return {
        ...state,
        aliases: state.aliases.filter((a) => a !== alias),
        log: log(`split: ${action.username} stands alone again`),
      };
    }

    case "purge-untracked": {
      const before = state.observations.length;
      const kept = state.observations.filter((o) => isTracked(state, o.provider, o.path));
      return {
        ...state,
        observations: kept,
        log: log(`purge: dropped ${before - kept.length} row(s) of untracked history`),
      };
    }

    case "edit-config":
      return {
        ...state,
        configProjects: action.projects,
        log: log("config.yaml edited by hand"),
      };
  }
}

/** What the projects page would show. */
export function repoView(state: State): { path: string; provider: Provider; rows: number }[] {
  return state.projects.map((p) => ({
    provider: p.provider,
    path: p.path,
    rows: state.observations.filter((o) => o.provider === p.provider && o.path === p.path).length,
  }));
}

/**
 * What the people page would show. Counts come from tracked projects only — the
 * same filter the projects page uses, because two pages disagreeing about a
 * count is the bug this rule exists to prevent.
 */
export function rosterView(
  state: State,
): { id: string; label: string; accounts: string[]; rows: number }[] {
  const byPerson = new Map<string, { accounts: Set<string>; rows: number }>();
  for (const o of state.observations) {
    if (!isTracked(state, o.provider, o.path)) continue;
    const id = personIdOf(state, o.provider, o.author);
    const entry = byPerson.get(id) ?? { accounts: new Set<string>(), rows: 0 };
    entry.accounts.add(key(o.provider, o.author));
    entry.rows++;
    byPerson.set(id, entry);
  }
  // A named or merged person with no visible rows still exists — otherwise
  // renaming somebody and then untracking their only project deletes the name.
  for (const person of state.persons) {
    if (!byPerson.has(person.id)) {
      byPerson.set(person.id, { accounts: new Set<string>(), rows: 0 });
    }
  }
  for (const alias of state.aliases) {
    const entry = byPerson.get(alias.personId);
    if (entry) entry.accounts.add(key(alias.provider, alias.username));
  }
  return [...byPerson.entries()]
    .map(([id, e]) => ({
      id,
      label: labelOf(state, id),
      accounts: [...e.accounts].sort(),
      rows: e.rows,
    }))
    .sort((a, b) => b.rows - a.rows || a.label.localeCompare(b.label));
}

/** Rows on disk that no page will ever show. */
export function orphanCount(state: State): number {
  return state.observations.filter((o) => !isTracked(state, o.provider, o.path)).length;
}
