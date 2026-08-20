/**
 * The two ranked lists on a project's page, and the caption that keeps them from
 * reading as a scoreboard.
 *
 * Extracted from `repo-detail` because the pair is one idea with one set of
 * rules, and those rules are subtle enough to want stating once: both are ARIA
 * grids rather than `<table>`s, both label their columns for a screen reader
 * only, both admit in `aria-rowcount` that the visible list is capped, and both
 * carry `NOT_A_SCORE`. Nothing above them needs to know any of that — the page
 * asks for `Authors` and `Reviewers` and gets rows that are already honest.
 */

import { Link } from "@tanstack/react-router";
import { identityKey, isBot } from "../../../src/census";
import type { Provider } from "../../../src/domain";
import type { AuthorStat, ReviewerStat } from "../../../src/insights";
import { Badge, providerLabel } from "./ui";
import { SUBTABLE_ROW } from "./system";

/** The caption that keeps a ranked list from reading as a scoreboard. */
export const NOT_A_SCORE =
  "Counts, not contribution. A 4000-line generated migration and a 40-line fix to a race condition are one pull request each.";

/** Author line totals reach six figures; the exact digit is never the point. */
function lines(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n);
}

// `identityKey` is the same `${provider}:${username}` the people route parses;
// it is imported rather than restated so the two cannot drift apart.

function PersonLink({
  provider,
  username,
}: {
  provider: Provider;
  username: string;
}) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <Link
        to="/people"
        search={{ id: identityKey(provider, username) }}
        className="min-w-0 truncate text-fg hover:text-accent hover:underline"
      >
        <span className="mr-1 font-mono text-meta text-fg-subtle">
          {providerLabel(provider)}
        </span>
        {username}
      </Link>
      {isBot(username) && (
        <Badge tone="mute" title="Matched the bot heuristic in census.ts">
          bot
        </Badge>
      )}
    </span>
  );
}

/** A proportion of the leader, drawn behind nothing. Purely a scanning aid. */
function Track({ value, peak }: { value: number; peak: number }) {
  return (
    <span className="block h-1 overflow-hidden rounded-full bg-surface-raised">
      <span
        className="block h-full bg-accent/70"
        style={{ width: `${peak === 0 ? 0 : (value / peak) * 100}%` }}
      />
    </span>
  );
}

/**
 * Every ranked list stops at 56rem.
 *
 * Uncapped, the author column took the full band and put a name two thousand
 * pixels from its own count — the same failure the board's row comment
 * describes. The cap is in `rem`, so it grows with the root font-size instead of
 * shrinking away on the wide screen it exists for.
 */
const LIST = "max-w-4xl";

export function Authors({ authors, max }: { authors: AuthorStat[]; max: number }) {
  if (authors.length === 0) {
    return <p className="text-body text-fg-subtle">No named authors — every account was hidden.</p>;
  }
  const peak = Math.max(1, ...authors.map((a) => a.opened));
  return (
    /*
     * Roles over the grid, not a `<table>`: every row is a
     * `grid-template-columns` the header has to match exactly, and the bar under
     * a name is drawn inside the first column, both of which a table would have
     * to re-express as `<col>` widths.
     *
     * The header row is `sr-only` because these columns were never labelled on
     * screen. Read aloud the rows were four numbers with no idea which was
     * which. `sr-only` is out of flow, so the `space-y-1.5` on the list below is
     * untouched and no pixel moves.
     *
     * `aria-rowcount` is the full author count while the list renders only the
     * first `max`. On a project where the two differ, the cap is not something a
     * reader can otherwise detect.
     */
    <div
      role="table"
      aria-label="Authors, most pull requests opened first"
      aria-rowcount={authors.length + 1}
      aria-colcount={4}
    >
      <div role="row" aria-rowindex={1} className="sr-only">
        <span role="columnheader">author</span>
        <span role="columnheader">opened</span>
        <span role="columnheader">merged and closed</span>
        <span role="columnheader">lines added and removed</span>
      </div>
      <ul role="presentation" className={LIST}>
        {authors.slice(0, max).map((author, i) => (
          <li
            role="row"
            aria-rowindex={i + 2}
            key={identityKey(author.provider, author.username)}
            // Column widths sized to the widest live values: `268m 14c` and
            // `+948k −453k` on `pok-auctions` both wrapped onto a second line at
            // the sizes this started with, which doubled every row's height.
            className={`${SUBTABLE_ROW} grid grid-cols-[minmax(0,1fr)_3rem_4.5rem_6.5rem] items-center gap-x-3 text-body`}
          >
            <span role="cell" className="min-w-0">
              <PersonLink provider={author.provider} username={author.username} />
              <Track value={author.opened} peak={peak} />
            </span>
            <span role="cell" className="text-right font-mono text-num text-fg">
              {author.opened}
            </span>
            <span
              role="cell"
              className="text-right font-mono text-num whitespace-nowrap text-fg-muted"
              title={`${author.merged} merged, ${author.closed} closed without merging`}
            >
              {author.merged}m {author.closed}c
            </span>
            <span
              role="cell"
              className="text-right font-mono text-num whitespace-nowrap text-fg-muted"
            >
              <span className="text-success">+{lines(author.additions)}</span>{" "}
              <span className="text-danger">−{lines(author.deletions)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Reviewers({ reviewers, max }: { reviewers: ReviewerStat[]; max: number }) {
  if (reviewers.length === 0) {
    return <p className="text-body text-fg-subtle">No review acts recorded.</p>;
  }
  const peak = Math.max(1, ...reviewers.map((r) => r.total));
  return (
    /* Same shape as `Authors`: `sr-only` column headers over the existing grid,
       and a row count that admits the list is capped at `max`. */
    <div
      role="table"
      aria-label="Reviewers, most review acts first"
      aria-rowcount={reviewers.length + 1}
      aria-colcount={3}
    >
      <div role="row" aria-rowindex={1} className="sr-only">
        <span role="columnheader">reviewer</span>
        <span role="columnheader">review acts</span>
        <span role="columnheader">approved, changes requested, commented</span>
      </div>
      <ul role="presentation" className={LIST}>
        {reviewers.slice(0, max).map((reviewer, i) => (
          <li
            role="row"
            aria-rowindex={i + 2}
            key={identityKey(reviewer.provider, reviewer.username)}
            className={`${SUBTABLE_ROW} grid grid-cols-[minmax(0,1fr)_3rem_8rem] items-center gap-x-3 text-body`}
          >
            <span role="cell" className="min-w-0">
              <PersonLink provider={reviewer.provider} username={reviewer.username} />
              <Track value={reviewer.total} peak={peak} />
            </span>
            <span role="cell" className="text-right font-mono text-num text-fg">
              {reviewer.total}
            </span>
            {/* Approvals, changes requested, comments. They do not sum to the
                total: a dismissed approval counts once here and in no bucket. */}
            <span
              role="cell"
              className="text-right font-mono text-num whitespace-nowrap text-fg-muted"
              title={`${reviewer.approved} approved, ${reviewer.changesRequested} changes requested, ${reviewer.commented} commented`}
            >
              <span className="text-success">{reviewer.approved}</span>
              {" / "}
              <span className="text-danger">{reviewer.changesRequested}</span>
              {" / "}
              {reviewer.commented}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
