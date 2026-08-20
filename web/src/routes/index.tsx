/**
 * The board.
 *
 * Grouping, filter and selection live in the URL, so a reload or a back button
 * restores the view — the TUI holds all three in memory and loses them on exit.
 *
 * The loader calls `getBoard`, which never touches the network. Syncing is the
 * button and nothing else. That is the invariant the tool is built on: a refresh
 * you did not ask for cannot destroy the diff.
 */

import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { byPr } from "../../../src/changes";
import { flatten, groupIntoBuckets } from "../../../src/domain";
import { matchesFilter, relativeAge } from "../../../src/render";
import { Detail } from "../components/detail";
import { Row } from "../components/row";
import { BUCKET_TONE } from "../components/ui";
import { getBoard, runSync } from "../server/board";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === "string" && search.q !== "" ? search.q : undefined,
    // Absent means grouped, because grouping by relevance is the whole point.
    flat: search.flat === true || search.flat === "true" ? true : undefined,
    pr: typeof search.pr === "string" ? search.pr : undefined,
  }),
  loader: () => getBoard(),
  component: Board,
});

function Board() {
  const board = Route.useLoaderData();
  const { q, flat, pr: selectedId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();

  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  /**
   * A scan that failed commits nothing, so its failures are **not** in the store
   * and re-reading after the sync cannot recover them. Without holding them here
   * the board silently showed only the half it could see — the exact failure this
   * tool exists to prevent. They are dropped on reload, because nothing persisted
   * them; the CLI has the same property, having printed them once.
   */
  const [scanFailures, setScanFailures] = useState<string[]>([]);

  const now = new Date(board.now);
  const changesByPr = byPr(board.changes);
  const filter = q ?? "";
  const visible = board.prs.filter((pr) => matchesFilter(pr, filter));
  const selected = board.prs.find((pr) => pr.id === selectedId) ?? null;

  // A PR that has left the set has no row to mark, so the count would otherwise
  // be the only trace of it. `left` carries the repo and nothing more, because
  // the store holds current rows only.
  const departed = board.changes.filter((c) => c.kind === "left");

  async function sync() {
    setSyncing(true);
    setSyncError(null);
    try {
      const result = await runSync();
      setScanFailures(result.failures);
      await router.invalidate();
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncing(false);
    }
  }

  // Deduplicated: a provider whose stored state is also unreadable would
  // otherwise be reported twice with the same words.
  const failures = [...new Set([...board.failures, ...scanFailures])];

  return (
    <div className="flex h-screen flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-800 bg-zinc-900/50 px-4 py-2.5">
        <h1 className="font-mono text-sm font-semibold text-zinc-100">prq</h1>

        <span className="text-xs text-zinc-500">
          {board.viewer === "" ? "not synced" : board.viewer}
          {" · "}
          {board.prs.length} open
          {" · "}
          {board.projects.length} project{board.projects.length === 1 ? "" : "s"}
          {board.lastSync !== null && (
            <> {" · "}synced {relativeAge(board.lastSync, now)} ago</>
          )}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <input
            type="search"
            value={filter}
            placeholder="filter"
            aria-label="Filter pull requests"
            onChange={(e) =>
              navigate({
                search: (prev) => ({
                  q: e.target.value || undefined,
                  flat: prev.flat,
                  pr: prev.pr,
                }),
                replace: true,
                resetScroll: false,
              })
            }
            className="w-40 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-sky-600 focus:outline-none"
          />

          <Link
            to="/"
            search={(prev) => ({
              q: prev.q,
              flat: flat ? undefined : true,
              pr: prev.pr,
            })}
            resetScroll={false}
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
          >
            {flat ? "group" : "flat"}
          </Link>

          <button
            type="button"
            onClick={sync}
            disabled={syncing}
            className="rounded bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {syncing ? "syncing…" : "sync"}
          </button>
        </div>
      </header>

      {(failures.length > 0 || syncError !== null || board.baselineReset) && (
        <div className="shrink-0 space-y-1 border-b border-zinc-800 bg-zinc-900/30 px-4 py-2">
          {board.baselineReset && (
            <p className="text-xs text-sky-300">
              Baseline set — the next sync is the first that can report changes.
            </p>
          )}
          {failures.map((failure) => (
            <p key={failure} className="text-xs text-amber-300">
              Incomplete — {failure}. Previous rows are still shown.
            </p>
          ))}
          {syncError !== null && (
            <p className="text-xs text-rose-300">Sync failed — {syncError}</p>
          )}
        </div>
      )}

      {departed.length > 0 && (
        <div className="shrink-0 border-b border-zinc-800 px-4 py-2 text-xs text-zinc-400">
          {departed.length} merged, closed, or no longer involving you
          <span className="text-zinc-500">
            {" — "}
            {[...new Set(departed.map((c) => c.from).filter((r): r is string => r !== null))].join(", ")}
          </span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <Empty synced={board.lastSync !== null} filtered={filter !== ""} />
          ) : flat ? (
            <ul>
              {flatten(visible).map((pr) => (
                <li key={pr.id}>
                  <Row
                    pr={pr}
                    changes={changesByPr.get(pr.id) ?? []}
                    selected={pr.id === selectedId}
                    now={now}
                  />
                </li>
              ))}
            </ul>
          ) : (
            groupIntoBuckets(visible).map((bucket) => (
              <section key={bucket.id}>
                <h2 className="sticky top-0 z-10 flex items-center gap-2 border-y border-zinc-800 bg-zinc-900/95 px-3 py-1.5 backdrop-blur">
                  <span
                    className={`h-2 w-2 rounded-full ${BUCKET_TONE[bucket.id].dot}`}
                  />
                  <span className="text-xs font-semibold text-zinc-200">
                    {bucket.label}
                  </span>
                  <span className="text-2xs text-zinc-500">
                    {bucket.items.length}
                  </span>
                </h2>
                <ul>
                  {bucket.items.map((pr) => (
                    <li key={pr.id}>
                      <Row
                        pr={pr}
                        changes={changesByPr.get(pr.id) ?? []}
                        selected={pr.id === selectedId}
                        now={now}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </main>

        <aside className="hidden w-[22rem] shrink-0 overflow-y-auto border-l border-zinc-800 bg-zinc-900/30 lg:block xl:w-[26rem] 2xl:w-[30rem]">
          {selected === null ? (
            <p className="p-4 text-xs text-zinc-500">
              Select a row to see its reviewers, stack, and what changed.
            </p>
          ) : (
            <Detail
              pr={selected}
              changes={changesByPr.get(selected.id) ?? []}
              now={now}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

function Empty({ synced, filtered }: { synced: boolean; filtered: boolean }) {
  if (filtered) {
    return <p className="p-4 text-xs text-zinc-500">Nothing matches that filter.</p>;
  }
  return (
    <p className="p-4 text-xs text-zinc-500">
      {synced
        ? "Nothing open concerns you."
        : "Nothing stored yet — press sync to fetch the first baseline."}
    </p>
  );
}
