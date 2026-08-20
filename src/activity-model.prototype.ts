/**
 * PROTOTYPE — throwaway. Run it with `bun run prototype:activity`.
 *
 * ## The question
 *
 * Projects and people need an active/inactive mark. The toggle is trivial; what
 * it *means* is not, because prq already has two adjacent mechanisms and a third
 * that overlaps:
 *
 *   - a project is **tracked or not** (a row in `project`), where untracked
 *     hides its history from every page;
 *   - a person is **a bot or not**, where a bot is hidden from the roster by name
 *     but still counted in a project's numbers.
 *
 * So four things have to be decided, and each has a plausible wrong answer:
 *
 *   1. Does an inactive project's stored history still count toward a person's
 *      profile? Say no, and archiving a dormant repo silently erases eleven of
 *      Marin's pull requests from his profile — work that really happened.
 *   2. Does an inactive person still count in a project's contributor list and
 *      its review coverage? Say no, and a project's history rewrites itself every
 *      time somebody leaves the company.
 *   3. If an inactive person turns up in a new census, do they reactivate? Say
 *      yes, and a deliberate human decision is silently undone by a cron job.
 *   4. Is "inactive" just bot-exclusion under another name? If the two are the
 *      same idea they must share one mechanism, or they will drift.
 *
 * The shape under test: **inactive is about what prq fetches and what it puts in
 * front of you — never about what happened.** History is a record; it does not
 * change because you stopped following a repository or somebody left.
 *
 * This module is the part worth keeping: a pure reducer, no I/O, no clock.
 */

export type Provider = "github" | "gitlab";

export interface ProjectRow {
  provider: Provider;
  path: string;
  active: boolean;
}

export interface PersonRow {
  id: string;
  label: string;
  active: boolean;
  /** By name, as today. Kept separate to answer question 4 by driving it. */
  bot: boolean;
}

/** One census row, standing in for `census_pr`. */
export interface Observation {
  provider: Provider;
  path: string;
  author: string;
  /** Which fetch produced it, so a re-fetch can be seen to skip. */
  round: number;
}

export interface State {
  projects: ProjectRow[];
  people: PersonRow[];
  observations: Observation[];
  round: number;
  log: string[];
}

export type Action =
  | { kind: "toggle-project"; provider: Provider; path: string }
  | { kind: "toggle-person"; id: string }
  | { kind: "remove-project"; provider: Provider; path: string }
  | { kind: "fetch" }
  | { kind: "new-work"; provider: Provider; path: string; author: string };

/** The world the fetch would find, if prq asked. */
const UPSTREAM: Observation[] = [
  { provider: "github", path: "nebulaltd/pok-auctions", author: "ermand", round: 0 },
  { provider: "github", path: "nebulaltd/pok-auctions", author: "dionverushi", round: 0 },
  { provider: "github", path: "nebulaltd/oddsy-backend", author: "dependabot", round: 0 },
  { provider: "gitlab", path: "kesh/kesh-back", author: "marin.hysollari", round: 0 },
  { provider: "gitlab", path: "kesh/kesh-back", author: "ddemaj", round: 0 },
];

export function initial(): State {
  return {
    projects: [
      { provider: "github", path: "nebulaltd/pok-auctions", active: true },
      { provider: "github", path: "nebulaltd/oddsy-backend", active: true },
      { provider: "gitlab", path: "kesh/kesh-back", active: true },
    ],
    people: [
      { id: "github:ermand", label: "Ermand Durro", active: true, bot: false },
      { id: "github:dionverushi", label: "Dion Verushi", active: true, bot: false },
      { id: "gitlab:marin.hysollari", label: "Marin Hysollari", active: true, bot: false },
      { id: "gitlab:ddemaj", label: "ddemaj", active: true, bot: false },
      { id: "github:dependabot", label: "dependabot", active: true, bot: true },
    ],
    observations: UPSTREAM.map((o) => ({ ...o, round: 1 })),
    round: 1,
    log: ["one fetch done; everything active"],
  };
}

const pkey = (p: Provider, path: string) => `${p}:${path}`;

function isTracked(state: State, provider: Provider, path: string): boolean {
  return state.projects.some((p) => p.provider === provider && p.path === path);
}

/** Only an active, tracked project is ever fetched. This is the whole point. */
function isFetchable(state: State, provider: Provider, path: string): boolean {
  return state.projects.some(
    (p) => p.provider === provider && p.path === path && p.active,
  );
}

export function personOf(state: State, provider: Provider, author: string): PersonRow | undefined {
  return state.people.find((p) => p.id === `${provider}:${author}`);
}

export function reduce(state: State, action: Action): State {
  const log = (message: string): string[] => [message, ...state.log].slice(0, 8);

  switch (action.kind) {
    case "toggle-project": {
      let became = "";
      const projects = state.projects.map((p) => {
        if (p.provider !== action.provider || p.path !== action.path) return p;
        became = p.active ? "inactive" : "active";
        return { ...p, active: !p.active };
      });
      return {
        ...state,
        projects,
        log: log(
          `${action.path} is now ${became}` +
            (became === "inactive" ? " — no longer fetched, history kept and still counted" : ""),
        ),
      };
    }

    case "toggle-person": {
      let became = "";
      const people = state.people.map((p) => {
        if (p.id !== action.id) return p;
        became = p.active ? "inactive" : "active";
        return { ...p, active: !p.active };
      });
      return {
        ...state,
        people,
        log: log(
          `${action.id} is now ${became}` +
            (became === "inactive" ? " — off the roster, still counted in project numbers" : ""),
        ),
      };
    }

    case "remove-project":
      // Kept alongside inactive deliberately, to see whether three states earn
      // their keep: untracked hides the history, inactive keeps it.
      return {
        ...state,
        projects: state.projects.filter(
          (p) => !(p.provider === action.provider && p.path === action.path),
        ),
        log: log(`${action.path} untracked — its history is now hidden everywhere`),
      };

    case "fetch": {
      const round = state.round + 1;
      const wanted = UPSTREAM.filter((o) => isFetchable(state, o.provider, o.path));
      const skipped = new Set(
        UPSTREAM.filter((o) => !isFetchable(state, o.provider, o.path)).map((o) =>
          pkey(o.provider, o.path),
        ),
      );
      // A fetch replaces what it covers and touches nothing else, exactly as
      // `writeCensus` does per project.
      const untouched = state.observations.filter(
        (o) => !wanted.some((w) => w.provider === o.provider && w.path === o.path),
      );
      return {
        ...state,
        round,
        observations: [...untouched, ...wanted.map((o) => ({ ...o, round }))],
        log: log(
          `fetch ${round}: ${wanted.length} row(s) from ${
            new Set(wanted.map((o) => pkey(o.provider, o.path))).size
          } project(s)` + (skipped.size > 0 ? `, skipped ${[...skipped].join(", ")}` : ""),
        ),
      };
    }

    case "new-work": {
      // Somebody inactive opens a pull request. The question is whether the mark
      // survives it.
      if (!isFetchable(state, action.provider, action.path)) {
        return {
          ...state,
          log: log(
            `new work in ${action.path} by ${action.author} — not fetched, project is not active`,
          ),
        };
      }
      const person = personOf(state, action.provider, action.author);
      return {
        ...state,
        observations: [
          ...state.observations,
          { ...action, round: state.round },
        ],
        // Deliberately no reactivation. The mark is a human decision; a fetch
        // must not overturn it silently. The view flags the contradiction instead.
        log: log(
          `new work in ${action.path} by ${action.author}` +
            (person !== undefined && !person.active
              ? " — they are marked inactive; flagged, NOT reactivated"
              : ""),
        ),
      };
    }
  }
}

/* ── Views. Each answers one of the four questions. ────────────────────────── */

export interface RepoView {
  key: string;
  active: boolean;
  rows: number;
  /** Contributors counted for this project: everybody, active or not. */
  contributors: number;
  lastFetch: number | null;
}

/**
 * Answers question 2. A project's numbers include inactive people, because the
 * work is a matter of record — somebody leaving does not un-write their code.
 */
export function repoView(state: State): RepoView[] {
  return state.projects.map((project) => {
    const rows = state.observations.filter(
      (o) => o.provider === project.provider && o.path === project.path,
    );
    return {
      key: pkey(project.provider, project.path),
      active: project.active,
      rows: rows.length,
      contributors: new Set(rows.filter((o) => !isBotAuthor(state, o)).map((o) => o.author)).size,
      lastFetch: rows.length === 0 ? null : Math.max(...rows.map((o) => o.round)),
    };
  });
}

function isBotAuthor(state: State, o: Observation): boolean {
  return personOf(state, o.provider, o.author)?.bot === true;
}

export interface RosterEntry {
  id: string;
  label: string;
  active: boolean;
  bot: boolean;
  /** Rows counted for this person: from every tracked project, active or not. */
  rows: number;
  /** True when an inactive person has work from the most recent fetch. */
  contradiction: boolean;
}

/**
 * Answers questions 1, 3 and 4. Rows come from every *tracked* project whether
 * or not it is active, so archiving a repository does not erase somebody's
 * history. Hidden-ness is one derived rule over two independent marks rather
 * than two competing mechanisms.
 */
export function rosterView(state: State): RosterEntry[] {
  return state.people.map((person) => {
    const [provider, username] = splitId(person.id);
    const rows = state.observations.filter(
      (o) =>
        o.author === username &&
        o.provider === provider &&
        isTracked(state, o.provider, o.path),
    );
    return {
      id: person.id,
      label: person.label,
      active: person.active,
      bot: person.bot,
      rows: rows.length,
      contradiction:
        !person.active && rows.some((o) => o.round === state.round) && state.round > 1,
    };
  });
}

/** What the roster shows by default: active humans. One rule, two marks. */
export function visibleRoster(
  state: State,
  show: { inactive: boolean; bots: boolean },
): RosterEntry[] {
  return rosterView(state).filter(
    (entry) => (entry.active || show.inactive) && (!entry.bot || show.bots),
  );
}

function splitId(id: string): [Provider, string] {
  const colon = id.indexOf(":");
  return [id.slice(0, colon) as Provider, id.slice(colon + 1)];
}

/** Rows on disk that no page will show, because their project is untracked. */
export function hiddenRows(state: State): number {
  return state.observations.filter((o) => !isTracked(state, o.provider, o.path)).length;
}
