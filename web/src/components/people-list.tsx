/**
 * The roster: every identity the census found, densest form that still scans.
 *
 * Two decisions here are about honesty rather than layout.
 *
 * Bots are out of the ranking by default. `dependabot` opened 126 pull requests
 * in this set, which puts it above all but three humans; a list sorted by volume
 * with a dependency updater sitting fourth is not a roster of contributors, it
 * is a roster of automation. The count of what was hidden stays on screen, so
 * the omission is visible rather than quietly convenient.
 *
 * The accounts a name stands for are the point of the page, not decoration.
 * `ermand` on GitHub and `ermandduro` on GitLab are one person only because the
 * database says so — prq never matches logins across forges on its own — and a
 * row whose numbers are a sum of two forges has to show both accounts or the
 * numbers are unexplainable. Merged rows tint their chips for the same reason.
 *
 * Those chips sit beside the name rather than in a column of their own, and that
 * is arithmetic rather than taste: with a 68rem cap the fixed columns take 42rem,
 * so a separate accounts column parked `gl kaziu` some 18rem to the right of the
 * name it explains. Once an identity has been renamed to "Kristi Aziu", the chip
 * is the only thing left that says which account that is.
 *
 * Renaming is here and not only on the profile because this is the bulk path:
 * 28 of the 29 identities in this set are raw forge logins — `kaziu`,
 * `bbregu141`, `luisalla-art` — and naming them by opening 28 profiles is the
 * wrong shape. The row stays a single link: the editor sits on top of it and
 * keeps its own clicks, so clicking a name opens a field while clicking anywhere
 * else on the row opens the profile.
 *
 * Sorting is the server's (opened + reviews, then label). Re-sorting here would
 * put two orderings of the same list in the codebase.
 */

import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { relativeAge } from "../../../src/render";
import type { PeoplePayload, PersonRow } from "../server/census";
import { NameEditor } from "./name-editor";
import { SameNameMerge, sameNameGroups } from "./same-name";
import { Badge, Pill, providerLabel } from "./ui";

/**
 * One place per column, because the header row and the data rows have to agree
 * on every width and there is no table to enforce it. Flex rather than a table
 * so the label can take the remaining width on a 3000px screen.
 */
const COL = {
  n: "w-16 shrink-0 text-right",
  age: "w-14 shrink-0 text-right",
};

/** Thousands separators without `toLocaleString`, whose grouping is a locale. */
const num = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * Label or account. The `gh ermand` form is included so the text the row
 * actually renders is searchable — typing what you can see should work.
 */
function matches(person: PersonRow, needle: string): boolean {
  if (needle === "") return true;
  const n = needle.toLowerCase();
  return (
    person.label.toLowerCase().includes(n) ||
    person.aliases.some(
      (a) =>
        a.username.toLowerCase().includes(n) ||
        `${providerLabel(a.provider)} ${a.username}`.toLowerCase().includes(n),
    )
  );
}

export function PeopleList({
  people,
  q,
  bots,
}: {
  people: PeoplePayload;
  q?: string;
  bots: boolean;
}) {
  const navigate = useNavigate();
  const filter = q ?? "";

  const found = people.people.filter((person) => matches(person, filter));
  const hiddenBots = bots ? 0 : found.filter((person) => person.bot).length;
  const visible = bots ? found : found.filter((person) => !person.bot);
  // Computed over what is on screen, so a filter that hides one half of a pair
  // does not leave a merge button pointing at a row you cannot see.
  const duplicates = sameNameGroups(visible);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-800 bg-zinc-900/50 px-4 py-2.5">
        <span className="text-xs text-zinc-500">
          {visible.length} identit{visible.length === 1 ? "y" : "ies"}
          {filter !== "" && <> {" · "}of {people.people.length}</>}
          {hiddenBots > 0 && (
            <>
              {" · "}
              <span className="text-zinc-400">
                {hiddenBots} bot{hiddenBots === 1 ? "" : "s"} hidden
              </span>
            </>
          )}
          {people.censusAt !== null && <> {" · "}census {people.censusAt.slice(0, 10)}</>}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <input
            type="search"
            value={filter}
            placeholder="filter"
            aria-label="Filter people by name or account"
            onChange={(e) =>
              navigate({
                to: "/people",
                search: { q: e.target.value || undefined, bots: bots ? true : undefined },
                replace: true,
                resetScroll: false,
              })
            }
            className="w-40 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-sky-600 focus:outline-none"
          />

          <Link
            to="/people"
            search={{ q, bots: bots ? undefined : true }}
            resetScroll={false}
            title="Include automation. dependabot opened 126 pull requests and reviewed none, so it is out of the ranking by default."
          >
            <Pill active={bots}>bots</Pill>
          </Link>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <p className="p-4 text-xs text-zinc-500">
            {filter === ""
              ? "No identities in the census."
              : hiddenBots > 0
                ? `Nothing matches that filter except ${hiddenBots} bot — turn on "bots" to see it.`
                : "Nothing matches that filter."}
          </p>
        ) : (
          /*
           * Capped and centred rather than full-bleed. A person's name is a dozen
           * characters and a roster row has nothing long in it, so on a 3000px
           * screen a flexible first column put "Ermand Durro" and his 815 a
           * thousand pixels apart — the same failure the board's rows document.
           * In `rem`, so the cap scales with the root font like everything else.
           */
          <div className="mx-auto w-full max-w-[68rem]">
            <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-zinc-800 bg-zinc-950/95 px-4 py-1.5 text-2xs tracking-wide text-zinc-500 uppercase backdrop-blur">
              <span className="min-w-0 flex-1">person · accounts</span>
              <span className={COL.n}>opened</span>
              <span className={COL.n}>merged</span>
              <span className={COL.n}>reviews</span>
              <span className={COL.n}>projects</span>
              <span className={COL.age}>last</span>
            </div>
            <ul>
              {visible.map((person) => (
                <li key={person.id}>
                  <PersonRowView
                    person={person}
                    group={duplicates.get(person.label.trim().toLowerCase())}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>
    </div>
  );
}
function PersonRowView({
  person,
  group,
}: {
  person: PersonRow;
  /** The other people sharing this display name, when there are any. */
  group?: PersonRow[];
}) {
  const merged = person.aliases.length > 1;
  const [editing, setEditing] = useState(false);

  /*
   * One link, stretched under the whole row, rather than a link wrapping the
   * cells. An `<input>` inside an `<a>` is invalid and a click inside it would
   * navigate; the editor therefore sits above this overlay on its own layer,
   * and everything else in the row is inert text the click falls through.
   * While a field is open the overlay is switched off, so a stray click in the
   * row cannot navigate away from half-typed text.
   */
  return (
    <div className="group relative flex items-center gap-3 border-b border-zinc-900 px-4 py-2 hover:bg-zinc-900/60">
      {!editing && (
        <Link
          to="/people"
          search={{ id: person.id }}
          aria-label={`Open ${person.label}`}
          className="absolute inset-0"
        />
      )}

      <span className="pointer-events-none flex min-w-0 flex-1 items-center gap-2">
        <NameEditor
          id={person.id}
          label={person.label}
          textClass="text-sm text-zinc-100"
          onEditingChange={setEditing}
        />
        {person.bot && <Badge tone="mute">bot</Badge>}
        {merged && (
          <Badge tone="info" title="One person across two forges, linked in the database">
            {person.aliases.length} forges
          </Badge>
        )}

        {/* Never hidden: after a rename the chip is the only thing on the row
            that still says which forge account these numbers came from. */}
        {person.aliases.map((alias) => (
          <Badge
            key={`${alias.provider}:${alias.username}`}
            tone={merged ? "info" : "mute"}
            title={`${alias.provider} account`}
          >
            <span className="opacity-60">{providerLabel(alias.provider)}</span>
            <span className="font-mono">{alias.username}</span>
          </Badge>
        ))}

        {group !== undefined && !editing && (
          <SameNameMerge person={person} group={group} />
        )}
      </span>

      <span className={`${COL.n} font-mono text-2xs text-zinc-200`}>{num(person.opened)}</span>
      <span className={`${COL.n} font-mono text-2xs text-zinc-400`}>{num(person.merged)}</span>
      <span className={`${COL.n} font-mono text-2xs text-zinc-200`}>{num(person.reviews)}</span>
      <span className={`${COL.n} font-mono text-2xs text-zinc-400`}>{person.repos}</span>
      <span className={`${COL.age} font-mono text-2xs text-zinc-500`}>
        {person.lastActivity === null ? "—" : relativeAge(person.lastActivity)}
      </span>
    </div>
  );
}
