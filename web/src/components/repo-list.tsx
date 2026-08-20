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
 */
const COLS =
  "grid grid-cols-[2.5rem_minmax(0,1fr)_4rem_3.5rem_4.5rem_3.5rem_4rem_4rem_4.5rem_5rem] items-center gap-x-3 px-4";

/** A zero is a fact, but it is never the fact being scanned for. */
function Num({ value }: { value: number }) {
  return (
    <span className={value === 0 ? "text-zinc-700" : "text-zinc-300"}>{value}</span>
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
    <span suppressHydrationWarning className="text-zinc-500">
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
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-800 bg-zinc-900/50 px-4 py-2.5">
        <span className="text-xs text-zinc-500">
          {repos.repos.length} project{repos.repos.length === 1 ? "" : "s"}
          {" · "}
          <span className="text-zinc-300">{repos.totals.total}</span> pull requests
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
            className="w-40 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-sky-600 focus:outline-none"
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={`${COLS} sticky top-0 z-10 border-b border-zinc-800 bg-zinc-900/95 py-1.5 text-2xs tracking-wide text-zinc-500 uppercase backdrop-blur`}
        >
          <span />
          <span>Project</span>
          <span className="text-right">PRs</span>
          <span className="text-right">Open</span>
          <span className="text-right">Merged</span>
          <span className="text-right">Closed</span>
          <span className="text-right">People</span>
          {/* Was "Active", which meant last activity. Renamed the moment a real
              active/inactive mark arrived beside it — two columns, one word. */}
          <span className="text-right">Last</span>
          <span className="text-right">Census</span>
          <span className="text-right">Fetching</span>
        </div>

        {visible.length === 0 ? (
          <p className="p-4 text-xs text-zinc-500">Nothing matches that filter.</p>
        ) : (
          <ul>
            {visible.map((row) => (
              <li key={row.key}>
                <ProjectRow row={row} now={now} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function ProjectRow({ row, now }: { row: RepoRow; now: Date }) {
  // Failure outranks truncation: a project that errored may be missing anything
  // at all, where a truncated one is merely missing its oldest history.
  const edge =
    row.failed !== null
      ? "border-l-rose-500/70 bg-rose-500/[0.04]"
      : row.truncated
        ? "border-l-amber-400/70 bg-amber-500/[0.03]"
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
      className={`${COLS} relative border-l-2 py-1.5 font-mono text-2xs hover:bg-zinc-800/60 ${edge} ${
        // Dimmed, never hidden: it is still tracked, still counted, and has to
        // stay findable to switch back on.
        row.active ? "" : "opacity-60"
      }`}
    >
      <Link
        to="/repos"
        search={(prev) => ({ ...prev, r: row.key })}
        resetScroll={false}
        title={row.failed ?? `${row.provider}:${row.repo}`}
        aria-label={`Open ${row.provider}:${row.repo}`}
        className="absolute inset-0"
      />

      <span className="pointer-events-none text-zinc-600">{providerLabel(row.provider)}</span>

      {/* The path is split so the informative end always renders: cutting from
          the right gives `…/kesh/k…`, losing exactly the segment that tells
          `kesh-back` from `kesh-front`. With no slash the prefix is empty and
          the leaf is the whole path, which is what `lastIndexOf` returning -1
          already yields. */}
      <span className="pointer-events-none flex min-w-0 items-baseline gap-2">
        <span className="flex min-w-0 shrink items-baseline">
          <span className="min-w-0 shrink truncate text-zinc-500">
            {row.repo.slice(0, row.repo.lastIndexOf("/") + 1)}
          </span>
          <span className="max-w-full shrink-0 truncate text-sm text-zinc-100">
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

      <span className="pointer-events-none text-right text-sm text-zinc-100">
        {row.counts.total}
      </span>
      <span className="pointer-events-none text-right">
        <Num value={row.counts.open} />
      </span>
      <span className="pointer-events-none text-right">
        <Num value={row.counts.merged} />
      </span>
      <span className="pointer-events-none text-right">
        <Num value={row.counts.closed} />
      </span>
      <span className="pointer-events-none text-right">
        <Num value={row.contributors} />
      </span>
      <span className="pointer-events-none text-right">
        <Age iso={row.lastActivity} now={now} />
      </span>
      <span className="pointer-events-none text-right">
        <Age iso={row.censusAt} now={now} />
      </span>

      <span className="flex justify-end">
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
