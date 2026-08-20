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
import { setPersonActive } from "../server/settings";
import { ActiveToggle } from "./active-toggle";
import { NameEditor } from "./name-editor";
import { SameNameMerge, sameNameGroups } from "./same-name";
import { Badge, Pill, providerLabel } from "./ui";
import {
  PAGE_FRAME,
  PAGE_TOOLBAR,
  TABLE_HEADER,
  TABLE_ROW,
  TOOLBAR_CONTENT,
  TOOLBAR_CONTROL,
} from "./system";

/**
 * One place per column, because the header row and the data rows have to agree
 * on every width and there is no table to enforce it. Flex rather than a table
 * so the label can take the remaining width on a 3000px screen.
 */
const COL = {
  n: "w-16 shrink-0 text-right",
  age: "w-14 shrink-0 text-right",
  /**
   * The width below which the row stops shrinking and the region scrolls
   * instead, shared by the header and the rows for the same reason the columns
   * are. Derived from the tracks: five fixed cells (four `w-16`, one `w-14`)
   * take 19.5rem, the five `gap-3` gutters add 3.75rem and `px-4` adds 2rem, so
   * the numbers need 25.25rem. The other 20rem is the identity cell, which
   * unlike a path column cannot truncate — it is `flex-1` holding a name, a
   * forge chip per account and two controls, none of which shrink. Measured at
   * 320px it resolved to `clientWidth: 0` and its chips spilled over the
   * numbers; the widest identity cell in this set measures 541px at 1440 and
   * the median around 325px, so 20rem holds a typical row and keeps the floor
   * under 768px, where nothing about this page changes.
   */
  min: "min-w-[45.25rem]",
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
  inactive,
}: {
  people: PeoplePayload;
  q?: string;
  bots: boolean;
  inactive: boolean;
}) {
  const navigate = useNavigate();
  const filter = q ?? "";

  const found = people.people.filter((person) => matches(person, filter));
  const visible = found.filter(
    (person) => (person.active || inactive) && (!person.bot || bots),
  );
  // One rule over two independent marks. A bot is a permanent property of an
  // account; inactive is somebody's decision. They are reported separately
  // because "hidden" would otherwise mean two different things.
  const hiddenBots = found.filter((person) => person.bot && !bots).length;
  const hiddenInactive = found.filter(
    (person) => !person.active && !person.bot && !inactive,
  ).length;
  // Computed over what is on screen, so a filter that hides one half of a pair
  // does not leave a merge button pointing at a row you cannot see.
  const duplicates = sameNameGroups(visible);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
       * The page had no heading of any level. The header spends its width on the
       * identity count and what is hidden rather than on a title, and the nav
       * already marks the tab — so the root heading is `sr-only` rather than a
       * second copy of the word "People" above it.
       */}
      <h1 className="sr-only">People</h1>
      <header className={PAGE_TOOLBAR}>
        <div className={`${PAGE_FRAME} ${TOOLBAR_CONTENT}`}>
          <span className="text-meta text-fg-muted">
            {visible.length} identit{visible.length === 1 ? "y" : "ies"}
            {filter !== "" && <> {" · "}of {people.people.length}</>}
            {hiddenInactive > 0 && (
              <>
                {" · "}
                <span className="text-attention">{hiddenInactive} inactive hidden</span>
              </>
            )}
            {hiddenBots > 0 && (
              <>
                {" · "}
                <span className="text-fg-muted">
                  {hiddenBots} bot{hiddenBots === 1 ? "" : "s"} hidden
                </span>
              </>
            )}
            {people.censusAt !== null && <> {" · "}census {people.censusAt.slice(0, 10)}</>}
          </span>

          <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
            <input
              type="search"
              value={filter}
              placeholder="Filter people"
              aria-label="Filter people by name or account"
              onChange={(e) =>
                navigate({
                  to: "/people",
                  search: {
                    q: e.target.value || undefined,
                    bots: bots ? true : undefined,
                    inactive: inactive ? true : undefined,
                  },
                  replace: true,
                  resetScroll: false,
                })
              }
              className={`${TOOLBAR_CONTROL} w-48`}
            />

            <Link
              to="/people"
              search={{ q, bots: bots ? true : undefined, inactive: inactive ? undefined : true }}
              resetScroll={false}
              title="Include people marked inactive. Their work still counts in every project's numbers; they are only off this list."
            >
              <Pill active={inactive}>inactive</Pill>
            </Link>

            <Link
              to="/people"
              search={{ q, bots: bots ? undefined : true, inactive: inactive ? true : undefined }}
              resetScroll={false}
              title="Include automation. dependabot opened 126 pull requests and reviewed none, so it is out of the ranking by default."
            >
              <Pill active={bots}>bots</Pill>
            </Link>
          </div>
        </div>
      </header>

      {/*
       * Scrolls on both axes. Horizontal had to be declared: with only
       * `overflow-y-auto` the cells past the right edge were reachable by an
       * accident of the cascade (an unset `overflow-x` computes to `auto` beside
       * a scrolling axis), with no scrollbar to say so, while the identity cell
       * was crushed to 0px. The region owns the scroll, `COL.min` the width.
       */}
      <main className="min-h-0 flex-1 overflow-auto">
        {visible.length === 0 ? (
          <p className="p-4 text-body text-fg-muted">
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
           *
           * The roles go on the elements that are already here — this capped box
           * is the only thing that parents both the header row and the rows, so
           * it is the table, and no wrapper is added. `<table>` was not an
           * option: the columns are flex widths shared between the header and
           * every row, and each row is a stretched link with an editor floating
           * over it.
           *
           * `aria-rowcount` is the census total rather than what survived the
           * filter, because three of the four controls in the header hide rows —
           * bots, inactive, and the search box — and "4 of 31" is the fact a
           * reader needs. Indices are 1-based over that total, header first.
           */
          <div
            role="table"
            aria-label="People"
            aria-rowcount={people.people.length + 1}
            aria-colcount={6}
            className={PAGE_FRAME}
          >
            <div
              role="row"
              aria-rowindex={1}
              className={`${COL.min} ${TABLE_HEADER} sticky top-0 z-10 flex items-center gap-3 border-b border-border-muted bg-canvas px-4 text-label tracking-wide text-fg-muted uppercase backdrop-blur`}
            >
              <span role="columnheader" className="min-w-0 flex-1">person · accounts</span>
              <span role="columnheader" className={COL.n}>opened</span>
              <span role="columnheader" className={COL.n}>merged</span>
              <span role="columnheader" className={COL.n}>reviews</span>
              <span role="columnheader" className={COL.n}>projects</span>
              <span role="columnheader" className={COL.age}>last</span>
            </div>
            {/* `presentation` on the list and its items: the rows are the `div`
                inside each `li`, and flattening the two elements above them is
                cheaper than hoisting the row markup out of `PersonRowView`. */}
            <ul role="presentation">
              {visible.map((person, i) => (
                <li role="presentation" key={person.id}>
                  <PersonRowView
                    person={person}
                    group={duplicates.get(person.label.trim().toLowerCase())}
                    rowIndex={i + 2}
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
  rowIndex,
}: {
  person: PersonRow;
  /** The other people sharing this display name, when there are any. */
  group?: PersonRow[];
  /** 1-based over the whole census, header included, to match `aria-rowcount`. */
  rowIndex: number;
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
    <div
      role="row"
      aria-rowindex={rowIndex}
      className={`${COL.min} ${TABLE_ROW} group relative flex items-center gap-3 border-b border-border-muted px-4 hover:bg-surface ${
        // Dimmed, never hidden here: this row is only reachable because a filter
        // asked for it, and it has to stay legible enough to switch back on.
        person.active ? "" : "border-l-2 border-l-attention/40 bg-attention/[0.03]"
      }`}
    >
      {/* The overlay moved inside the first cell when the row became a
          `role="row"`, which may hold nothing but cells. `absolute inset-0` still
          resolves against the row — no cell is a containing block — so the hit
          area is unchanged, and `pointer-events-auto` lifts the link back out of
          the inert cell it now lives in. */}
      <span
        role="cell"
        className="pointer-events-none flex min-w-0 flex-1 items-center gap-2"
      >
        {!editing && (
          <Link
            to="/people"
            search={{ id: person.id }}
            aria-label={`Open ${person.label}`}
            className="pointer-events-auto absolute inset-0"
          />
        )}
        <NameEditor
          id={person.id}
          label={person.label}
          textClass="text-title text-fg"
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
            <span className="text-fg-muted">{providerLabel(alias.provider)}</span>
            <span className="font-mono">{alias.username}</span>
          </Badge>
        ))}

        {group !== undefined && !editing && (
          <SameNameMerge person={person} group={group} />
        )}

        {!editing && (
          <ActiveToggle
            active={person.active}
            what={person.label}
            inactiveHint="stops them appearing on this roster; every number they contributed stays exactly where it is"
            onToggle={(active) => setPersonActive({ data: { id: person.id, active } })}
          />
        )}

        {/* Surfaced, never acted on. A census must not silently overturn somebody's
            decision, but a mark this stale is worth a second look. */}
        {person.contradiction && (
          <Badge tone="urgent" title="Marked inactive, but has activity in the last 30 days">
            active recently
          </Badge>
        )}
      </span>

      <span role="cell" className={`${COL.n} font-mono text-num text-fg`}>{num(person.opened)}</span>
      <span role="cell" className={`${COL.n} font-mono text-num text-fg-muted`}>{num(person.merged)}</span>
      <span role="cell" className={`${COL.n} font-mono text-num text-fg`}>{num(person.reviews)}</span>
      <span role="cell" className={`${COL.n} font-mono text-num text-fg-muted`}>{person.repos}</span>
      <span role="cell" className={`${COL.age} font-mono text-num text-fg-muted`}>
        {person.lastActivity === null ? "—" : relativeAge(person.lastActivity)}
      </span>
    </div>
  );
}
