/**
 * Settings: the tracked project list, and the only page that writes.
 *
 * Three things here exist because the underlying rules are the opposite of what
 * the controls look like, and hiding that would make the page lie:
 *
 *   - Removing a project keeps its census rows. Every census read filters on the
 *     tracked set, so the rows go invisible rather than away, and adding the
 *     project back restores its history without the ~2m21s a census costs. A
 *     button labelled "remove" that keeps the data has to say so at the click,
 *     not in a tooltip, so the confirm step spells the whole rule out.
 *   - A project added here has nothing behind it until `prq census` runs. The
 *     row appears with `0` stored, which reads as "empty project" rather than
 *     "not scanned yet"; the outcome line says which it is.
 *   - Purging is the only destructive control on the page, and it is the one
 *     that looks like housekeeping. Its confirm says permanent, and names the
 *     full census that undoing it would cost.
 *
 * The table is `repo-list.tsx`'s shape, for the reason it was chosen there: 34
 * rows of small numbers are read by scanning a column. Only 20 of those 34 have
 * ever been censused, so `stored` and `census` are the two columns that carry
 * the page — a tracked project and a scanned one are not the same thing, and the
 * difference is 14 rows of zeroes that are not empty projects.
 *
 * The path is split on its last slash so the leaf survives truncation —
 * `albanian-technology-distribution/kesh/kesh-back` is 46 characters and three
 * segments deep, and cutting from the right turns it into `…/kesh/k…`, losing
 * exactly the segment that tells `kesh-back` from `kesh-front`.
 *
 * Errors are rendered verbatim, at the control that caused them. The store
 * rejects a path with the shape it wanted ("a github project must be owner/name
 * — rejected: …"); replacing that with "invalid path" throws away the fix.
 */

import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Provider } from "../../../src/domain";
import { relativeAge } from "../../../src/render";
import type { ProjectRow, SettingsPayload } from "../server/settings";
import { addProject, purgeUntracked, removeProject } from "../server/settings";
import { providerLabel } from "./ui";

/**
 * Shared by the header labels and every row so the two cannot drift. Widths in
 * `rem`, because the root font-size scales with the viewport: the columns grow
 * with the digits they hold instead of stranding them on a 3000px screen.
 */
const COLS =
  "grid grid-cols-[2.5rem_minmax(0,1fr)_5rem_5rem_5rem_6rem] items-center gap-x-3 px-4";

/**
 * Everything in the scrolling area is capped and centred rather than
 * full-bleed. With six columns and only four numbers, a flexible path column on
 * a 3008px screen put `nebulaltd/oddsy-backend` and its row count ~1900px
 * apart — the failure the roster documents. 64rem is the widest the table needs:
 * the fixed columns take 29.25rem and the longest path, the 46-character
 * `albanian-technology-distribution/kesh/kesh-back`, takes ~26rem.
 */
const PANEL = "mx-auto w-full max-w-[64rem]";

/** A zero is a fact, but it is never the fact being scanned for. */
function Num({ value }: { value: number }) {
  return <span className={value === 0 ? "text-zinc-700" : "text-zinc-300"}>{value}</span>;
}

/**
 * Ages render against the browser's clock, a second or so past the clock that
 * rendered the HTML. Crossing a minute boundary in that second is a hydration
 * text mismatch, so these spans opt out of the check — the value is right in
 * both renders, just not identical.
 *
 * A missing census is not a missing age, so it does not render as `—`: 13 of
 * the 33 tracked projects have never been scanned, and "never" in the column
 * that means it says more than a badge repeated down a third of the table.
 */
function Age({ iso, now }: { iso: string | null; now: Date }) {
  if (iso === null) return <span className="text-amber-300/70">never</span>;
  return (
    <span suppressHydrationWarning className="text-zinc-500">
      {relativeAge(iso, now)}
    </span>
  );
}

/**
 * Server function rejections arrive as whatever crossed the wire. The message is
 * the payload — it names the required shape — so it is dug out rather than
 * replaced, and an unrecognised value is stringified instead of dropped.
 */
function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  if (cause !== null && typeof cause === "object" && "message" in cause) {
    const { message } = cause as { message: unknown };
    if (typeof message === "string") return message;
  }
  return String(cause);
}

const key = (provider: Provider, path: string) => `${provider}:${path}`;

/** Which failure belongs to which control, so it renders where the click was. */
interface Message {
  id: string;
  text: string;
}

/**
 * What a mutation did, kept as a fact rather than as a finished sentence.
 *
 * An add comes back with nothing but `added`, and the interesting half is on
 * disk: re-adding `nebulaltd/bond-backend` found 186 census rows still there,
 * while a genuinely new project has none. Only the re-read loader data knows
 * which, so the sentence is composed at render — an outcome string built inside
 * the handler was built from the pre-invalidation props, and told the user
 * "0 stored rows" directly above a row reading 186.
 */
type Outcome =
  | { kind: "added"; id: string }
  | { kind: "already"; id: string }
  | { kind: "removed"; id: string; stored: number }
  | { kind: "absent"; id: string }
  | { kind: "purged"; deleted: number };

function outcomeText(outcome: Outcome, projects: ProjectRow[]): string {
  switch (outcome.kind) {
    case "added": {
      const row = projects.find((p) => key(p.provider, p.path) === outcome.id);
      return row === undefined || row.stored === 0
        ? `now tracking ${outcome.id} — it has no history until \`prq census\` runs, which is why it lists 0 stored rows`
        : `now tracking ${outcome.id} again — the ${row.stored} row${row.stored === 1 ? " it already had was" : "s it already had were"} still on disk, so its history is back without a census`;
    }
    case "already":
      return `${outcome.id} was already tracked — nothing changed`;
    case "removed":
      return outcome.stored === 0
        ? `untracked ${outcome.id} — it had no stored rows, so nothing was hidden and nothing was lost`
        : `untracked ${outcome.id} — its ${outcome.stored} stored row${outcome.stored === 1 ? " was" : "s were"} kept and hidden; adding it back restores the history with no census`;
    case "absent":
      return `${outcome.id} was not tracked — nothing changed`;
    case "purged":
      return `deleted ${outcome.deleted} untracked row${outcome.deleted === 1 ? "" : "s"} — pull requests and the reviews stored with them, gone for good`;
  }
}

export function SettingsPanel({ settings }: { settings: SettingsPayload }) {
  const router = useRouter();
  const now = new Date();

  // Which row is mid-confirm, by `provider:path`. One at a time: two open
  // confirms on a destructive control are two chances to hit the wrong one.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // Outcomes are kept apart from failures: "already tracked" is a fact about the
  // store, not an error, and colouring it like one would misreport it.
  const [said, setSaid] = useState<Outcome | null>(null);
  const [failed, setFailed] = useState<Message | null>(null);

  const github = settings.projects.filter((p) => p.provider === "github").length;
  const gitlab = settings.projects.length - github;
  const stored = settings.projects.reduce((sum, p) => sum + p.stored, 0);
  const uncensused = settings.projects.filter((p) => p.censusAt === null).length;

  /**
   * Every mutation ends the same way: the loader re-reads the store. Nothing is
   * patched locally, because the store decided what happened — an add can come
   * back `false`, and a remove keeps rows a local splice would have dropped.
   */
  async function run(id: string, act: () => Promise<Outcome>) {
    setBusy(id);
    setFailed(null);
    setSaid(null);
    try {
      const outcome = await act();
      await router.invalidate();
      setSaid(outcome);
      setConfirming(null);
      setPurging(false);
    } catch (cause) {
      setFailed({ id, text: errorText(cause) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-zinc-800 bg-zinc-900/50 px-4 py-2.5">
        <span className="text-xs text-zinc-500">
          {settings.projects.length} tracked project
          {settings.projects.length === 1 ? "" : "s"}
          {" · "}
          {github} github, {gitlab} gitlab
          {" · "}
          <span className="text-zinc-300">{stored}</span> stored pull requests
          {uncensused > 0 && (
            <>
              {" · "}
              <span className="text-amber-300/80">
                {uncensused} never censused
              </span>
            </>
          )}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className={`${PANEL} px-4 pt-3 pb-1 text-xs text-zinc-500`}>
          The config file holds only <code className="text-zinc-300">statePath</code> — where the
          database lives. Which projects are tracked, and who the people are, is managed here in the
          database. Nothing on this page reaches a forge: it writes local rows, and filling them
          still takes <code className="text-zinc-300">prq sync</code> or{" "}
          <code className="text-zinc-300">prq census</code>.
          {settings.configPath !== "" && (
            <>
              {" "}
              This session was pointed at{" "}
              <code
                className="text-zinc-400"
                title="From --state or PRQ_STATE, which overrides the config's statePath"
              >
                {settings.configPath}
              </code>
              .
            </>
          )}
        </p>

        {/* Amber, not red: a config that still lists projects is stale, not
            broken. Nothing is failing — a file is being edited to no effect. */}
        {settings.notices.map((notice) => (
          <p
            key={notice}
            className={`${PANEL} border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-200`}
          >
            {notice}
          </p>
        ))}

        <AddProject
          busy={busy === "add"}
          failed={failed !== null && failed.id === "add" ? failed.text : null}
          onSubmit={(provider, path) =>
            run("add", async () => {
              const result = await addProject({ data: { provider, path } });
              const id = key(provider, result.path);
              return result.added ? { kind: "added", id } : { kind: "already", id };
            })
          }
        />

        {/* One status line for the page. A removed row is gone by the time its
            outcome is read, so the sentence cannot live in the row. */}
        {said !== null && (
          <p
            className={`${PANEL} border-b border-zinc-800 bg-zinc-900/40 px-4 py-2 text-xs text-zinc-300`}
          >
            {outcomeText(said, settings.projects)}
          </p>
        )}

        <div
          className={`${PANEL} ${COLS} sticky top-0 z-10 border-b border-zinc-800 bg-zinc-900/95 py-1.5 text-2xs tracking-wide text-zinc-500 uppercase backdrop-blur`}
        >
          <span />
          <span>Project</span>
          <span className="text-right">Stored</span>
          <span className="text-right">Census</span>
          <span className="text-right">Added</span>
          <span className="text-right">Tracking</span>
        </div>

        {settings.projects.length === 0 ? (
          <p className="p-4 text-xs text-zinc-500">
            No projects tracked. Add one above; a census is what fills it.
          </p>
        ) : (
          <ul className={PANEL}>
            {settings.projects.map((row) => {
              const id = key(row.provider, row.path);
              return (
                <li key={id}>
                  <ProjectLine
                    row={row}
                    now={now}
                    confirming={confirming === id}
                    busy={busy === id}
                    failed={failed !== null && failed.id === id ? failed.text : null}
                    onAsk={() => {
                      setConfirming(id);
                      setFailed(null);
                      setSaid(null);
                    }}
                    onCancel={() => setConfirming(null)}
                    onRemove={() =>
                      run(id, async () => {
                        const { removed } = await removeProject({
                          data: { provider: row.provider, path: row.path },
                        });
                        // `row.stored` is the count that was on screen when the
                        // confirm was read, which is the number the sentence
                        // promised to keep.
                        return removed
                          ? { kind: "removed", id, stored: row.stored }
                          : { kind: "absent", id };
                      })
                    }
                  />
                </li>
              );
            })}
          </ul>
        )}

        {/* Rendered only when there is something to reclaim: a purge control
            sitting at 0 rows invites a destructive click that does nothing,
            which teaches the click. */}
        {settings.orphanRows > 0 && (
          <section className={`${PANEL} border-t border-zinc-800 px-4 py-3`}>
            {/* `orphanRows` counts pull requests, not every row a purge takes:
                purging 37 untracked pull requests deleted 199 rows, because the
                reviews stored with them go too. The confirm says so rather than
                naming a number the deletion will exceed. */}
            <p className="text-xs text-zinc-400">
              <span className="text-zinc-200">{settings.orphanRows}</span> stored pull request
              {settings.orphanRows === 1 ? " belongs" : "s belong"} to projects that are no longer
              tracked. They are still on disk and invisible to every page — kept so re-adding those
              projects brings their history back for free.
            </p>

            {purging ? (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded border border-rose-500/40 bg-rose-500/[0.06] px-3 py-2">
                <span className="text-xs text-rose-200">
                  Deletes the {settings.orphanRows} stored pull request
                  {settings.orphanRows === 1 ? "" : "s"} and every review stored with
                  {settings.orphanRows === 1 ? " it" : " them"}, permanently. Not reversible:
                  getting that history back afterwards means a full census of those projects, about
                  2m21s each.
                </span>
                <span className="ml-auto flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy === "purge"}
                    onClick={() =>
                      run("purge", async () => {
                        const { deleted } = await purgeUntracked();
                        return { kind: "purged", deleted };
                      })
                    }
                    className="rounded border border-rose-500/60 bg-rose-500/20 px-2 py-1 text-2xs text-rose-100 hover:bg-rose-500/30 disabled:opacity-50"
                  >
                    {busy === "purge" ? "deleting…" : "delete permanently"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPurging(false)}
                    className="rounded border border-zinc-700 px-2 py-1 text-2xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-100"
                  >
                    keep them
                  </button>
                </span>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setPurging(true);
                  setFailed(null);
                  setSaid(null);
                }}
                className="mt-2 rounded border border-zinc-700 px-2 py-1 text-2xs text-zinc-400 hover:border-rose-500/60 hover:text-rose-200"
              >
                purge untracked rows…
              </button>
            )}

            {failed !== null && failed.id === "purge" && (
              <p className="mt-2 font-mono text-xs text-rose-300">{failed.text}</p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

/**
 * Both fields are held in state so a rejected submit keeps what was typed.
 * Retyping a 46-character GitLab path to fix one character in it is the worst
 * possible answer to an error message that already names the fix.
 */
function AddProject({
  busy,
  failed,
  onSubmit,
}: {
  busy: boolean;
  failed: string | null;
  onSubmit: (provider: Provider, path: string) => void;
}) {
  const [provider, setProvider] = useState<Provider>("github");
  const [path, setPath] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (path.trim() !== "") onSubmit(provider, path.trim());
      }}
      className={`${PANEL} border-b border-zinc-800 px-4 py-3`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-2xs tracking-wide text-zinc-500 uppercase" htmlFor="add-provider">
          track
        </label>
        <select
          id="add-provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value === "gitlab" ? "gitlab" : "github")}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 focus:border-sky-600 focus:outline-none"
        >
          <option value="github">github</option>
          <option value="gitlab">gitlab</option>
        </select>

        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={provider === "github" ? "owner/name" : "group/project (nested is fine)"}
          aria-label="Project path"
          spellCheck={false}
          className="w-[26rem] max-w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-sky-600 focus:outline-none"
        />

        <button
          type="submit"
          disabled={busy || path.trim() === ""}
          className="rounded border border-sky-600/60 bg-sky-500/15 px-2.5 py-1 text-xs text-sky-200 hover:bg-sky-500/25 disabled:border-zinc-700 disabled:bg-transparent disabled:text-zinc-600"
        >
          {busy ? "adding…" : "add project"}
        </button>
      </div>

      {/* Verbatim, beside the input that caused it: the store's message names
          the shape it wanted, which is the whole fix. */}
      {failed !== null && (
        <p className="mt-2 font-mono text-xs text-rose-300">{failed}</p>
      )}
    </form>
  );
}

function ProjectLine({
  row,
  now,
  confirming,
  busy,
  failed,
  onAsk,
  onCancel,
  onRemove,
}: {
  row: ProjectRow;
  now: Date;
  confirming: boolean;
  busy: boolean;
  failed: string | null;
  onAsk: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const leaf = row.path.lastIndexOf("/") + 1;

  return (
    <div
      className={`border-l-2 ${
        confirming ? "border-l-amber-400/70 bg-amber-500/[0.04]" : "border-l-transparent"
      }`}
    >
      <div className={`${COLS} py-1.5 font-mono text-2xs`}>
        <span className="text-zinc-600">{providerLabel(row.provider)}</span>

        {/* Split on the last slash so the informative end always renders: the
            prefix absorbs the truncation, the leaf never does. */}
        <span
          className="flex min-w-0 items-baseline"
          title={`${row.provider}:${row.path}`}
        >
          <span className="min-w-0 shrink truncate text-zinc-500">{row.path.slice(0, leaf)}</span>
          <span className="max-w-full shrink-0 truncate text-sm text-zinc-100">
            {row.path.slice(leaf)}
          </span>
        </span>

        <span className="text-right">
          <Num value={row.stored} />
        </span>
        <span className="text-right">
          <Age iso={row.censusAt} now={now} />
        </span>
        <span className="text-right">
          <Age iso={row.addedAt} now={now} />
        </span>

        <span className="text-right">
          {confirming ? (
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-zinc-700 px-1.5 py-0.5 text-2xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-100"
            >
              cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={onAsk}
              className="rounded border border-zinc-800 px-1.5 py-0.5 text-2xs text-zinc-500 hover:border-amber-500/60 hover:text-amber-200"
            >
              remove…
            </button>
          )}
        </span>
      </div>

      {/* Inline rather than a modal: the row it is about stays on screen, and
          the sentence that matters is the one a modal would have buried. */}
      {confirming && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-2">
          {/* A project that has never been censused has no history to keep, and
              promising that removing it "keeps its rows" would be a sentence
              about 0 rows. 13 of the 33 tracked projects are in that state. */}
          <span className="text-xs text-amber-100/90">
            {row.stored === 0 ? (
              <>
                Stops being scanned. It has no stored rows yet, so nothing is hidden and nothing is
                lost — adding <span className="font-mono">{row.path}</span> back leaves it exactly
                where it is now, waiting on a census.
              </>
            ) : (
              <>
                Stops being scanned. Its {row.stored} stored row{row.stored === 1 ? "" : "s"}{" "}
                {row.stored === 1 ? "is" : "are"} kept on disk and hidden from every page, not
                deleted — adding <span className="font-mono">{row.path}</span> back restores the
                history with no census needed.
              </>
            )}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={onRemove}
            className="ml-auto rounded border border-amber-500/60 bg-amber-500/15 px-2 py-0.5 text-2xs text-amber-100 hover:bg-amber-500/25 disabled:opacity-50"
          >
            {busy ? "untracking…" : "untrack it"}
          </button>
          {failed !== null && <p className="w-full font-mono text-xs text-rose-300">{failed}</p>}
        </div>
      )}
    </div>
  );
}
