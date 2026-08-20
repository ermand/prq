/**
 * Every censused project, one line each.
 *
 * A table rather than cards. Twenty projects with nine numbers apiece is 180
 * figures, and the only question the page answers — which project is big, busy,
 * or broken — is answered by scanning a column, which cards make impossible.
 * The board's row already established the shape: fixed columns on the right,
 * the path absorbing the slack on the left.
 *
 * The one place colour is spent is failure. A census that errored stores the
 * runs it managed and nothing more, so `kesh-back` with a dead token and
 * `kesh-back` with no pull requests render as the same zero — and one of those
 * is a lie. `failed` and `truncated` therefore get a badge and a coloured left
 * edge, the same treatment the board gives a PR that moved.
 */

import { Link, useNavigate } from "@tanstack/react-router";
import { relativeAge } from "../../../src/render";
import type { RepoRow, ReposPayload } from "../server/census";
import { setProjectActive } from "../server/settings";
import { ActiveToggle } from "./active-toggle";
import { Badge, providerLabel } from "./ui";

/**
 * Shared by the header labels and every row, so the two cannot drift. Widths
 * are in `rem` because the root font-size scales with the viewport: at 3008px
 * these columns grow with the digits they hold instead of stranding them.
 *
 * The `min-w` is the floor below which this grid stops degrading and starts
 * losing columns, derived from the tracks above rather than picked: nine fixed
 * tracks sum to 35.5rem, the nine `gap-x-3` gutters add 6.75rem and `px-4`
 * adds 2rem, so the numbers alone need 44.25rem. Left at that, `minmax(0,1fr)`
 * resolves to zero below 708px and every project path renders 0px wide — which
 * is what was happening: at 320px the path column measured `clientWidth: 0`
 * while 379 elements sat past the right edge. The extra 3.75rem is the slack
 * the path has at 768px, the narrowest viewport the audit measured clean, so
 * the path never gets thinner than it already was there and nothing changes at
 * or above it — below it the region scrolls instead of dropping columns.
 */
const COLS =
  "grid min-w-[48rem] grid-cols-[2.5rem_minmax(0,1fr)_4rem_3.5rem_4.5rem_3.5rem_4rem_4rem_4.5rem_5rem] items-center gap-x-3 px-4";

/** A zero is a fact, but it is never the fact being scanned for. */
function Num({ value }: { value: number }) {
  return (
    <span className={value === 0 ? "text-fg-subtle" : "text-fg"}>{value}</span>
  );
}

/**
 * Ages are rendered against the browser's clock, which is a second or so past
 * the clock that rendered the HTML. Crossing a minute boundary in that second
 * would be a hydration text mismatch, so the age spans opt out of the check —
 * the value is correct in both renders, just not identical.
 */
function Age({ iso, now }: { iso: string | null; now: Date }) {
  return (
    <span suppressHydrationWarning className="text-fg-muted">
      {iso === null ? "—" : relativeAge(iso, now)}
    </span>
  );
}

export function RepoList({ repos, q }: { repos: ReposPayload; q?: string }) {
  const navigate = useNavigate({ from: "/repos" });
  const now = new Date();
  const filter = (q ?? "").trim().toLowerCase();

  // Matches the path, not the provider prefix: typing `gitlab` to mean "the
  // GitLab ones" is a forge filter, and this list is short enough not to need
  // one. Sort came from the server (total descending); it is not touched here.
  const visible =
    filter === ""
      ? repos.repos
      : repos.repos.filter((row) => row.repo.toLowerCase().includes(filter));

  const broken = repos.repos.filter((row) => row.failed !== null).length;
  const clipped = repos.repos.filter((row) => row.truncated).length;

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      {/*
       * The page had no heading of any level. The header below spends its width
       * on totals rather than a title, and the nav already marks the tab, so a
       * visible title would be duplicated chrome — `sr-only` gives the document
       * its root heading without changing a pixel.
       */}
      <h1 className="sr-only">Projects</h1>
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border-muted bg-surface px-4 py-2.5">
        <span className="text-body text-fg-muted">
          {repos.repos.length} project{repos.repos.length === 1 ? "" : "s"}
          {" · "}
          <span className="text-fg">{repos.totals.total}</span> pull requests
          {" · "}
          {repos.totals.open} open, {repos.totals.merged} merged,{" "}
          {repos.totals.closed} closed
          {" · "}
          {repos.people} people
          {repos.censusAt !== null && (
            <>
              {" · "}
              <span suppressHydrationWarning>
                oldest census {relativeAge(repos.censusAt, now)} ago
              </span>
            </>
          )}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {broken > 0 && (
            <Badge tone="bad" title="These projects hold whatever was read before the error">
              {broken} census failure{broken === 1 ? "" : "s"}
            </Badge>
          )}
          {clipped > 0 && (
            <Badge tone="warn" title="Hit the page cap — the oldest history is missing">
              {clipped} truncated
            </Badge>
          )}
          <input
            type="search"
            value={q ?? ""}
            placeholder="filter"
            aria-label="Filter projects by path"
            onChange={(e) =>
              navigate({
                search: (prev) => ({ ...prev, q: e.target.value || undefined }),
                replace: true,
                resetScroll: false,
              })
            }
            className="w-40 rounded border border-border bg-surface px-2 py-1 text-chip text-fg placeholder:text-fg-subtle focus:border-accent"
          />
        </div>
      </header>

      {/*
       * Scrolls on both axes. Horizontally it had to be declared: with only
       * `overflow-y-auto` the columns past the viewport were reachable by an
       * accident of the cascade (an unset `overflow-x` computes to `auto` beside
       * a scrolling axis) and there was no scrollbar to say so, while the grid
       * itself quietly gave the project path 0px. Now the region owns the
       * horizontal scroll and `COLS` owns the width it scrolls to.
       */}
      <div className="min-h-0 flex-1 overflow-auto">
        {/*
         * ARIA roles on the existing grid, not a `<table>`. The header row and
         * every data row share one `grid-template-columns`, and each row carries
         * a link stretched across it — a real table would need the template to
         * become `<col>` widths and the overlay to leave the row box, so the
         * roles are laid over the markup instead.
         *
         * The wrapper exists because a `role="table"` has to be the parent of
         * its rows: the header row and the `ul` were siblings with nothing above
         * them but the scroll box, which also holds the empty-state sentence
         * below. That sentence stays outside the table, where a role-less
         * paragraph is allowed to be.
         *
         * `aria-rowcount` is the unfiltered total, because typing in the filter
         * shrinks the rows in the DOM and a reader is entitled to know that 4 of
         * 33 are showing. Row indices are 1-based over that total with the
         * header at 1, which is what makes the count coherent.
         */}
        <div
          role="table"
          aria-label="Censused projects"
          aria-rowcount={repos.repos.length + 1}
          aria-colcount={10}
        >
          <div
            role="row"
            aria-rowindex={1}
            className={`${COLS} sticky top-0 z-10 border-b border-border-muted bg-surface py-1.5 text-label tracking-wide text-fg-muted uppercase backdrop-blur`}
          >
            {/* The forge column is a two-letter mark with no room for a word, so
                its header is a label rather than text. */}
            <span role="columnheader" aria-label="Forge" />
            <span role="columnheader">Project</span>
            <span role="columnheader" className="text-right">PRs</span>
            <span role="columnheader" className="text-right">Open</span>
            <span role="columnheader" className="text-right">Merged</span>
            <span role="columnheader" className="text-right">Closed</span>
            <span role="columnheader" className="text-right">People</span>
            {/* Was "Active", which meant last activity. Renamed the moment a real
                active/inactive mark arrived beside it — two columns, one word. */}
            <span role="columnheader" className="text-right">Last</span>
            <span role="columnheader" className="text-right">Census</span>
            <span role="columnheader" className="text-right">Fetching</span>
          </div>

          {/* `presentation` on both, so the list semantics do not fight the table
              semantics: the roles stay on the elements that already exist and the
              rows flatten up to the table, rather than a wrapper being added per
              row to hold them. */}
          {visible.length > 0 && (
            <ul role="presentation">
              {visible.map((row, i) => (
                <li role="presentation" key={row.key}>
                  <ProjectRow row={row} now={now} rowIndex={i + 2} />
                </li>
              ))}
            </ul>
          )}
        </div>

        {visible.length === 0 && (
          <p className="p-4 text-body text-fg-muted">Nothing matches that filter.</p>
        )}
      </div>
    </main>
  );
}

function ProjectRow({ row, now, rowIndex }: { row: RepoRow; now: Date; rowIndex: number }) {
  // Failure outranks truncation: a project that errored may be missing anything
  // at all, where a truncated one is merely missing its oldest history.
  const edge =
    row.failed !== null
      ? "border-l-danger/70 bg-danger/[0.04]"
      : row.truncated
        ? "border-l-attention/70 bg-attention/[0.03]"
        : "border-l-transparent";

  return (
    /*
     * A div with a stretched link underneath, not a link wrapping the cells. The
     * toggle is a `<button>`, and a button inside an anchor is invalid HTML that
     * browsers mangle — the same defect the board row was rebuilt to avoid. The
     * cells are inert text the click falls through; the toggle sits above on its
     * own layer.
     */
    <div
      role="row"
      aria-rowindex={rowIndex}
      className={`${COLS} relative border-l-2 py-1.5 font-mono text-num hover:bg-surface ${edge} ${
        // Dimmed, never hidden: it is still tracked, still counted, and has to
        // stay findable to switch back on.
        row.active ? "" : "border-l-attention/40 bg-attention/[0.03]"
      }`}
    >
      {/* The link lives inside the first cell rather than beside it: a `role="row"`
          may only hold cells, and an anchor parked between them is a child the
          role does not allow. It is still `absolute inset-0` against the row —
          the cell is not a containing block — so the whole row stays clickable,
          and `pointer-events-auto` is what gets it back out from under the
          inert cell it now sits in. */}
      <span role="cell" className="pointer-events-none text-meta text-fg-subtle">
        <Link
          to="/repos"
          search={(prev) => ({ ...prev, r: row.key })}
          resetScroll={false}
          title={row.failed ?? `${row.provider}:${row.repo}`}
          aria-label={`Open ${row.provider}:${row.repo}`}
          className="pointer-events-auto absolute inset-0"
        />
        {providerLabel(row.provider)}
      </span>

      {/* The path is split so the informative end always renders: cutting from
          the right gives `…/kesh/k…`, losing exactly the segment that tells
          `kesh-back` from `kesh-front`. With no slash the prefix is empty and
          the leaf is the whole path, which is what `lastIndexOf` returning -1
          already yields. */}
      <span role="cell" className="pointer-events-none flex min-w-0 items-baseline gap-2">
        <span className="flex min-w-0 shrink items-baseline">
          <span className="min-w-0 shrink truncate text-meta text-fg-muted">
            {row.repo.slice(0, row.repo.lastIndexOf("/") + 1)}
          </span>
          <span className="max-w-full shrink-0 truncate text-title text-fg">
            {row.repo.slice(row.repo.lastIndexOf("/") + 1)}
          </span>
        </span>
        {row.failed !== null && (
          <Badge tone="bad" title={row.failed}>
            census failed
          </Badge>
        )}
        {row.truncated && (
          <Badge tone="warn" title="Hit the page cap — the oldest history is missing">
            truncated
          </Badge>
        )}
      </span>

      <span role="cell" className="pointer-events-none text-right text-lead text-fg">
        {row.counts.total}
      </span>
      <span role="cell" className="pointer-events-none text-right">
        <Num value={row.counts.open} />
      </span>
      <span role="cell" className="pointer-events-none text-right">
        <Num value={row.counts.merged} />
      </span>
      <span role="cell" className="pointer-events-none text-right">
        <Num value={row.counts.closed} />
      </span>
      <span role="cell" className="pointer-events-none text-right">
        <Num value={row.contributors} />
      </span>
      <span role="cell" className="pointer-events-none text-right">
        <Age iso={row.lastActivity} now={now} />
      </span>
      <span role="cell" className="pointer-events-none text-right">
        <Age iso={row.censusAt} now={now} />
      </span>

      <span role="cell" className="flex justify-end">
        <ActiveToggle
          active={row.active}
          what={`${row.provider}:${row.repo}`}
          inactiveHint="stops it being synced and censused; its stored history keeps counting everywhere"
          onToggle={(active) =>
            setProjectActive({ data: { provider: row.provider, path: row.repo, active } })
          }
        />
      </span>
    </div>
  );
}
