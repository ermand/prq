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
import { BUCKET_TONE, Pill } from "../components/ui";
import { getBoard, runSync } from "../server/board";

/**
 * Every parameter is optional, and the annotation below is what makes that true
 * for the type system too. Inferred, the validator's return has *required* keys
 * holding `undefined`, which forces every `Link` in the app — including the nav
 * bar, which knows nothing about the board — to restate all six.
 */
export interface BoardSearch {
  q?: string;
  flat?: boolean;
  pr?: string;
  changed?: boolean;
  prov?: "github" | "gitlab";
  nodraft?: boolean;
}

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): BoardSearch => ({
    q: typeof search.q === "string" && search.q !== "" ? search.q : undefined,
    // Absent means grouped, because grouping by relevance is the whole point.
    flat: search.flat === true || search.flat === "true" ? true : undefined,
    pr: typeof search.pr === "string" ? search.pr : undefined,
    /**
     * The three filters the text box provably cannot express. `q` already
     * matches title, repo, author and number, so anything textual would be
     * duplicate machinery; these are structural.
     *
     * `changed` is the TUI's `c` key, which the board never had — the one
     * genuine feature gap between the two front-ends.
     */
    changed: search.changed === true || search.changed === "true" ? true : undefined,
    prov:
      search.prov === "github" || search.prov === "gitlab" ? search.prov : undefined,
    nodraft: search.nodraft === true || search.nodraft === "true" ? true : undefined,
  }),
  loader: () => getBoard(),
  component: Board,
});

function Board() {
  const board = Route.useLoaderData();
  const { q, flat, pr: selectedId, changed, prov, nodraft } = Route.useSearch();
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
  const visible = board.prs.filter(
    (pr) =>
      matchesFilter(pr, filter) &&
      (prov === undefined || pr.provider === prov) &&
      (nodraft !== true || !pr.draft) &&
      // A change entry keyed to this row is what "changed" means; a `left` change
      // has no row to match, which is why departures stay in the header.
      (changed !== true || (changesByPr.get(pr.id)?.length ?? 0) > 0),
  );
  const selected = board.prs.find((pr) => pr.id === selectedId) ?? null;

  /**
   * Every link below spreads this. The router requires a **total** search
   * object, so an earlier attempt to spread `prev` typechecked as optional keys
   * and silently dropped filters; naming all six once is what keeps the
   * compiler able to catch a forgotten one.
   */
  const search = { q, flat, pr: selectedId, changed, prov, nodraft };

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
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
       * The page had no `<h1>` — it started at the bucket `<h2>` — and the
       * nav already says which tab is active, so a visible title would be
       * duplicated chrome above a header that spends its width on counts.
       * `sr-only` gives the document a root heading without taking a pixel.
       */}
      <h1 className="sr-only">Board</h1>
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border-muted bg-surface px-4 py-2.5">

        <span className="text-meta text-fg-muted">
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
                search: { ...search, q: e.target.value || undefined },
                replace: true,
                resetScroll: false,
              })
            }
            className="w-40 rounded border border-border bg-surface px-2 py-1 text-chip text-fg placeholder:text-fg-subtle focus:border-accent"
          />

          <Link
            to="/"
            search={{ ...search, changed: changed ? undefined : true }}
            resetScroll={false}
            title="Only rows that moved since the last sync — the TUI's `c`"
          >
            <Pill active={changed === true}>changed</Pill>
          </Link>

          {/* Cycles rather than offering three controls: with two forges a single
              tap-through is fewer pixels and fewer decisions. */}
          <Link
            to="/"
            search={{
              ...search,
              prov:
                prov === undefined ? "github" : prov === "github" ? "gitlab" : undefined,
            }}
            resetScroll={false}
            title="Filter by forge"
          >
            <Pill active={prov !== undefined}>
              {prov === undefined ? "forge" : prov === "github" ? "gh" : "gl"}
            </Pill>
          </Link>

          <Link
            to="/"
            search={{ ...search, nodraft: nodraft ? undefined : true }}
            resetScroll={false}
            title="Hide drafts"
          >
            <Pill active={nodraft === true}>no drafts</Pill>
          </Link>

          <Link
            to="/"
            search={{ ...search, flat: flat ? undefined : true }}
            resetScroll={false}
          >
            <Pill active={flat === true}>{flat ? "group" : "flat"}</Pill>
          </Link>

          <button
            type="button"
            onClick={sync}
            disabled={syncing}
            className="rounded bg-accent-emphasis px-2.5 py-1 text-chip text-white hover:bg-accent hover:text-canvas disabled:cursor-not-allowed disabled:opacity-50"
          >
            {syncing ? "syncing…" : "sync"}
          </button>
        </div>
      </header>

      {(failures.length > 0 || syncError !== null || board.baselineReset) && (
        <div className="shrink-0 space-y-1 border-b border-border-muted bg-surface px-4 py-2">
          {board.baselineReset && (
            <p className="text-body text-accent">
              Baseline set — the next sync is the first that can report changes.
            </p>
          )}
          {failures.map((failure) => (
            <p key={failure} className="text-body text-attention">
              Incomplete — {failure}. Previous rows are still shown.
            </p>
          ))}
          {syncError !== null && (
            <p className="text-body text-danger">Sync failed — {syncError}</p>
          )}
        </div>
      )}

      {departed.length > 0 && (
        <div className="shrink-0 border-b border-border-muted px-4 py-2 text-body text-fg-muted">
          {departed.length} merged, closed, or no longer involving you
          <span className="text-fg-muted">
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
                <div className="sticky top-0 z-10 flex items-center gap-2 border-y border-border-muted bg-surface px-3 py-1.5 backdrop-blur">
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 rounded-full ${BUCKET_TONE[bucket.id].dot}`}
                  />
                  {/*
                   * The count is a sibling of the heading, not part of it. Glued
                   * together the accessible name measured as `Awaiting me2`,
                   * which a screen reader says as "Awaiting me two"; the
                   * `aria-label` restates the pair with the separation a sighted
                   * reader gets for free from the gap.
                   */}
                  <h2
                    className="text-group text-fg"
                    aria-label={`${bucket.label}, ${bucket.items.length} pull request${
                      bucket.items.length === 1 ? "" : "s"
                    }`}
                  >
                    {bucket.label}
                  </h2>
                  <span className="font-mono text-num text-fg-muted">
                    {bucket.items.length}
                  </span>
                </div>
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

        <aside className="hidden w-[22rem] shrink-0 overflow-y-auto border-l border-border-muted bg-surface lg:block xl:w-[26rem] 2xl:w-[30rem]">
          {selected === null ? (
            <p className="p-4 text-body text-fg-muted">
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
    return <p className="p-4 text-body text-fg-muted">Nothing matches that filter.</p>;
  }
  return (
    <p className="p-4 text-body text-fg-muted">
      {synced
        ? "Nothing open concerns you."
        : "Nothing stored yet — press sync to fetch the first baseline."}
    </p>
  );
}
