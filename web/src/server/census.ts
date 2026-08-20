/**
 * The census surface: projects and people, from stored history.
 *
 * Read-only, like every other server function here, and it touches no network —
 * these pages read what `prq census` last wrote. That keeps a page load from
 * costing two minutes and 55 rate-limit points.
 *
 * Measured on this machine: 2181 pull requests, 3565 review acts and 32
 * identities spanning 4.7 years. Small enough that every one of these handlers
 * reads the whole census and computes in memory, and large enough that doing it
 * per row in SQL would not have been clearer.
 */

import { createServerFn } from "@tanstack/react-start";
import {
  identityKey,
  isBot,
  resolvePeople,
  type CensusPr,
  type CensusReview,
  type Person,
} from "../../../src/census";
import type { Precision, Provider } from "../../../src/domain";
import {
  personInsight,
  repoInsight,
  type PersonInsight,
  type RepoInsight,
  type StateCounts,
} from "../../../src/insights";
import { withStore } from "./with-store";
import type { Store } from "../../../src/store";

/**
 * Review timestamps exist on GitHub and not on GitLab, so latency is exact on
 * one forge and unknowable on the other. Derived from the provider rather than
 * stored per row: it is a property of the API, not of the data, and `insights`
 * refuses to compute latency at all when it is `approximate`.
 */
function precisionOf(provider: Provider): Precision {
  return provider === "github" ? "exact" : "approximate";
}

export interface RepoRow {
  /** `${provider}:${repo}` — the route key, since GitLab paths carry slashes. */
  key: string;
  provider: Provider;
  repo: string;
  counts: StateCounts;
  contributors: number;
  lastActivity: string | null;
  censusAt: string | null;
  failed: string | null;
  truncated: boolean;
}

export interface ReposPayload {
  repos: RepoRow[];
  totals: StateCounts;
  /** Oldest census across projects — a fresh half must not hide a stale one. */
  censusAt: string | null;
  people: number;
  /** True when no census has ever run, so the pages can say so plainly. */
  empty: boolean;
}

export interface PersonRow {
  id: string;
  label: string;
  bot: boolean;
  /**
   * False when marked inactive. Two independent marks, one shared filter: a bot
   * is a permanent property of an account, inactive is somebody's decision, and
   * collapsing them would make "hide from the roster" mean two different things.
   */
  active: boolean;
  aliases: { provider: Provider; username: string }[];
  opened: number;
  merged: number;
  reviews: number;
  repos: number;
  lastActivity: string | null;
  /**
   * True when somebody marked inactive still has recent work. Surfaced rather
   * than acted on: a census must never silently reactivate a person, but a
   * contradiction worth a second look should be visible.
   */
  contradiction: boolean;
}

export interface PeoplePayload {
  people: PersonRow[];
  censusAt: string | null;
  empty: boolean;
}

export interface RepoDetailPayload {
  key: string;
  insight: RepoInsight | null;
  censusAt: string | null;
  failed: string | null;
  truncated: boolean;
}

export interface PersonDetailPayload {
  insight: PersonInsight | null;
}

/** The oldest census time, or null when nothing has been censused. */
function oldestCensus(store: Store): string | null {
  const times = store
    .censusRuns()
    .map((run) => run.at.toISOString())
    .sort();
  return times[0] ?? null;
}

function peopleOf(store: Store, rules: { label: string; aliases: { provider: Provider; username: string }[] }[]) {
  return resolvePeople(
    store.contributors().map((c) => ({ provider: c.provider, username: c.username })),
    rules,
  );
}

/**
 * One predicate, used by every census read. Removing a project untracks it and
 * keeps its rows — so this is what makes the removal visible everywhere at once,
 * and what lets a re-add restore the history without the ~2m21s a census costs.
 */
function trackedFilter(store: Store): (row: { provider: Provider; repo: string }) => boolean {
  const keys = new Set(store.projects().map((p) => `${p.provider}:${p.path}`));
  return (row) => keys.has(`${row.provider}:${row.repo}`);
}

export const getRepos = createServerFn({ method: "GET" }).handler(() =>
  withStore((store, { people: rules }): ReposPayload => {
    const tracked = store.projects();
    const trackedKeys = new Set(tracked.map((p) => `${p.provider}:${p.path}`));
    // Only tracked rows count anywhere. Removing a project untracks it and keeps
    // its history on disk, so an unfiltered read would keep showing a project
    // the driver has stopped following.
    const prs = store.censusPrs().filter((pr) => trackedKeys.has(`${pr.provider}:${pr.repo}`));
    const runs = store.censusRuns();
    const byKey = new Map<string, CensusPr[]>();
    for (const pr of prs) {
      const key = `${pr.provider}:${pr.repo}`;
      const bucket = byKey.get(key);
      if (bucket) bucket.push(pr);
      else byKey.set(key, [pr]);
    }

    // Driven by the tracked list, not by the census log. A project added a minute
    // ago has no run row yet, and omitting it here would leave the driver
    // wondering whether it took — it appears with an honest zero and a null
    // census time instead.
    const repos: RepoRow[] = tracked.map((project) => {
      const key = `${project.provider}:${project.path}`;
      const run = runs.find((r) => r.provider === project.provider && r.repo === project.path);
      const rows = byKey.get(key) ?? [];
      const counts: StateCounts = {
        open: rows.filter((r) => r.state === "open").length,
        merged: rows.filter((r) => r.state === "merged").length,
        closed: rows.filter((r) => r.state === "closed").length,
        total: rows.length,
      };
      // Bots excluded: `dependabot` authored 126 pull requests across two of
      // these projects, and counting a dependency updater under a column headed
      // "people" is the same lie the roster refuses to tell. A project is
      // single-forge, so no cross-forge merge can apply within one row.
      const authors = new Set<string>();
      let lastActivity: string | null = null;
      for (const row of rows) {
        if (row.author !== "" && !isBot(row.author)) authors.add(row.author);
        if (lastActivity === null || row.updatedAt > lastActivity) lastActivity = row.updatedAt;
      }
      return {
        key,
        provider: project.provider,
        repo: project.path,
        counts,
        contributors: authors.size,
        lastActivity,
        censusAt: run?.at.toISOString() ?? null,
        failed: run?.failed ?? null,
        truncated: run?.truncated ?? false,
      };
    });

    repos.sort((a, b) => b.counts.total - a.counts.total || a.key.localeCompare(b.key));

    return {
      repos,
      totals: {
        open: prs.filter((r) => r.state === "open").length,
        merged: prs.filter((r) => r.state === "merged").length,
        closed: prs.filter((r) => r.state === "closed").length,
        total: prs.length,
      },
      censusAt: oldestCensus(store),
      // Humans, not accounts. Counting identities here read 30 while the roster
      // read 29, because one had merged the driver's two forge logins and the
      // other had not — two pages disagreeing about the same quantity.
      people: peopleOf(store, rules).people.filter((p) =>
        p.aliases.every((a) => !isBot(a.username)),
      ).length,
      // Empty means "nothing to show yet", which is true both before a census and
      // before any project is tracked — the page's wording covers both.
      empty: tracked.length === 0,
    };
  }),
);

export const getRepo = createServerFn({ method: "GET" })
  .validator((key: unknown): string => {
    if (typeof key !== "string" || key === "") throw new Error("repo key required");
    return key;
  })
  .handler(({ data: key }) =>
    withStore((store): RepoDetailPayload => {
      const split = key.indexOf(":");
      const provider = key.slice(0, split);
      const repo = key.slice(split + 1);
      if ((provider !== "github" && provider !== "gitlab") || repo === "") {
        return { key, insight: null, censusAt: null, failed: null, truncated: false };
      }
      // An untracked project reads as absent, not as empty. Its rows are still on
      // disk and would otherwise render a full page for something the driver
      // removed.
      const isTracked = store
        .projects()
        .some((p) => p.provider === provider && p.path === repo);
      if (!isTracked) {
        return { key, insight: null, censusAt: null, failed: null, truncated: false };
      }
      const run = store.censusRuns().find((r) => r.provider === provider && r.repo === repo);
      const prs = store.censusPrs({ provider, repo });
      const reviews = store.censusReviews({ provider, repo });
      return {
        key,
        insight:
          run === undefined
            ? null
            : repoInsight(prs, reviews, precisionOf(provider), new Date()),
        censusAt: run?.at.toISOString() ?? null,
        failed: run?.failed ?? null,
        truncated: run?.truncated ?? false,
      };
    }),
  );

export const getPeople = createServerFn({ method: "GET" }).handler(() =>
  withStore((store, { people: rules }): PeoplePayload => {
    const { people, of } = peopleOf(store, rules);
    // Tracked only, matching the projects page exactly. Two pages disagreeing
    // about a count is the bug this single rule exists to prevent.
    const onTracked = trackedFilter(store);
    const prs = store.censusPrs().filter(onTracked);
    const reviews = store.censusReviews().filter(onTracked);

    const tally = new Map<
      string,
      { opened: number; merged: number; reviews: number; repos: Set<string>; last: string | null }
    >();
    const seed = (id: string) => {
      let row = tally.get(id);
      if (!row) {
        row = { opened: 0, merged: 0, reviews: 0, repos: new Set<string>(), last: null };
        tally.set(id, row);
      }
      return row;
    };

    for (const pr of prs) {
      if (pr.author === "") continue;
      const id = of.get(identityKey(pr.provider, pr.author));
      if (id === undefined) continue;
      const row = seed(id);
      row.opened++;
      if (pr.state === "merged") row.merged++;
      row.repos.add(`${pr.provider}:${pr.repo}`);
      if (row.last === null || pr.updatedAt > row.last) row.last = pr.updatedAt;
    }
    for (const review of reviews) {
      if (review.reviewer === "") continue;
      const id = of.get(identityKey(review.provider, review.reviewer));
      if (id === undefined) continue;
      const row = seed(id);
      row.reviews++;
      row.repos.add(`${review.provider}:${review.repo}`);
    }

    // A month, in milliseconds. "Recent" has to mean something, and a census is
    // run occasionally rather than nightly, so a tighter window would flag
    // nothing on a store that was last read three weeks ago.
    const RECENT_MS = 30 * 24 * 60 * 60 * 1000;
    const recentAfter = new Date(Date.now() - RECENT_MS).toISOString();

    const rows: PersonRow[] = people.map((person: Person) => {
      const row = tally.get(person.id);
      return {
        id: person.id,
        label: person.label,
        // A merged person is a bot only if every one of its accounts is.
        bot: person.aliases.every((a) => isBot(a.username)),
        active: person.active,
        aliases: person.aliases,
        opened: row?.opened ?? 0,
        merged: row?.merged ?? 0,
        reviews: row?.reviews ?? 0,
        repos: row?.repos.size ?? 0,
        lastActivity: row?.last ?? null,
        contradiction:
          !person.active && row?.last !== undefined && row.last !== null && row.last > recentAfter,
      };
    });

    rows.sort(
      (a, b) =>
        b.opened + b.reviews - (a.opened + a.reviews) || a.label.localeCompare(b.label),
    );

    return { people: rows, censusAt: oldestCensus(store), empty: rows.length === 0 };
  }),
);

export const getPerson = createServerFn({ method: "GET" })
  .validator((id: unknown): string => {
    if (typeof id !== "string" || id === "") throw new Error("person id required");
    return id;
  })
  .handler(({ data: id }) =>
    withStore((store, { people: rules }): PersonDetailPayload => {
      const { people } = peopleOf(store, rules);
      const person = people.find((p) => p.id === id);
      if (person === undefined) return { insight: null };

      // Only this person's rows for the acts they performed, but every row for
      // the reviews they *received* — those live on other people's pull
      // requests. Cheap enough to read the whole census at this size.
      const onTracked = trackedFilter(store);
      const prs: CensusPr[] = store.censusPrs().filter(onTracked);
      const reviews: CensusReview[] = store.censusReviews().filter(onTracked);

      // Exact only when every forge this person works on records timestamps. One
      // GitLab account is enough to make a merged latency figure a half-truth.
      const precision: Precision = person.aliases.every((a) => precisionOf(a.provider) === "exact")
        ? "exact"
        : "approximate";

      return { insight: personInsight(person, prs, reviews, precision, new Date()) };
    }),
  );
