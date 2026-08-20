/**
 * People: the roster, and one person's profile.
 *
 * Same one-route-two-views shape as projects, and for a related reason: a person
 * id is either a configured slug or `provider:username`, and the second form
 * carries a colon that has no business in a path segment.
 *
 * A word on what this page is and is not. It counts pull requests, review acts
 * and lines changed, because those are what the forges record. None of them
 * measures how much somebody contributed — a 4000-line generated migration and
 * a 40-line fix to a race condition are one PR each. The profile is deliberately
 * built to make that visible rather than to hide it behind a single score.
 */

import { createFileRoute } from "@tanstack/react-router";
import { PersonProfile } from "../components/person-profile";
import { PeopleList } from "../components/people-list";
import { getPeople, getPerson } from "../server/census";

/** Optional by annotation, so a `Link` need not restate the whole shape. */
export interface PeopleSearch {
  /** Person id — a config slug, or `provider:username`. Absent is the roster. */
  id?: string;
  q?: string;
  bots?: boolean;
  /** Reveal people marked inactive. Their numbers were never withheld. */
  inactive?: boolean;
}

export const Route = createFileRoute("/people")({
  validateSearch: (search: Record<string, unknown>): PeopleSearch => ({
    /** Person id — a config slug, or `provider:username`. Absent is the roster. */
    id: typeof search.id === "string" && search.id !== "" ? search.id : undefined,
    q: typeof search.q === "string" && search.q !== "" ? search.q : undefined,
    /** Bots are excluded by default; `dependabot` outranks most of the humans. */
    bots: search.bots === true || search.bots === "true" ? true : undefined,
    // Inactive people are hidden by default too, and for the same reason: the
    // roster answers "who is on the team", not "who ever committed".
    inactive: search.inactive === true || search.inactive === "true" ? true : undefined,
  }),
  loaderDeps: ({ search }) => ({ id: search.id }),
  loader: async ({ deps }) => ({
    people: await getPeople(),
    profile: deps.id === undefined ? null : await getPerson({ data: deps.id }),
  }),
  component: People,
});

function People() {
  const { people, profile } = Route.useLoaderData();
  const { id, q, bots, inactive } = Route.useSearch();

  if (people.empty) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center">
        <p className="max-w-md text-center text-xs leading-relaxed text-zinc-500">
          No census yet. Run <code className="text-zinc-300">prq census</code> first —
          contributors are derived from stored history, and the board's sync only ever
          sees pull requests that involve you.
        </p>
      </main>
    );
  }

  if (id !== undefined && profile !== null) {
    return <PersonProfile profile={profile} />;
  }

  return (
    <PeopleList people={people} q={q} bots={bots === true} inactive={inactive === true} />
  );
}
