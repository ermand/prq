/**
 * The terminal UI.
 *
 * Layout, keymap and stack treatment are **prototype** choices — wayfinder
 * tickets 0011 and 0008 are still open. The bucket order, sorting and state
 * vocabulary they render are settled.
 *
 * The list is one Text node with a manually managed viewport rather than a
 * reconciled tree: rebuilding a few hundred styled lines per keypress is
 * cheaper than diffing, and it keeps scroll behaviour under our control.
 */

import {
  bold,
  createCliRenderer,
  dim,
  fg,
  link,
  stringToStyledText,
  StyledText,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type TextChunk,
} from "@opentui/core";
import {
  buildRows,
  formatRow,
  selectableIndices,
  statusLine,
  type Row,
  type ViewState,
} from "./render";
import type { PullRequest } from "./domain";
import { byPr, headline, label, type Change } from "./changes";

const COLOR = {
  approved: "#7ee787",
  changes: "#ff7b72",
  awaiting: "#79c0ff",
  optional: "#8b949e",
  bucket: "#d2a8ff",
  cursor: "#1f6feb",
  warn: "#f0883e",
  changed: "#d29922",
} as const;

const VERDICT_COLOR: Record<PullRequest["verdict"], string> = {
  approved: COLOR.approved,
  "changes-requested": COLOR.changes,
  "awaiting-review": COLOR.awaiting,
  "review-optional": COLOR.optional,
};

export interface SyncedState {
  prs: PullRequest[];
  changes: Change[];
  failures: string[];
  at: Date;
  viewer: string;
  baselineReset: boolean;
}

export interface AppOptions {
  prs: PullRequest[];
  /** Changes recorded by the last sync. Empty on a first run. */
  changes: Change[];
  viewer: string;
  repos: string[];
  /** Null when nothing has ever been synced. */
  lastSync: Date | null;
  baselineReset: boolean;
  sync: (signal: AbortSignal) => Promise<SyncedState>;
}

const HELP =
  "j/k move · o open · y copy · s stack · c changed · g group · / filter · S sync · ? help · q quit";

/**
 * Child processes get PATH and nothing else. `open` and `pbcopy` have no use
 * for a repo-scoped GitHub token, and Bun.spawn inherits the full environment
 * by default.
 */
const SPAWN_ENV = { PATH: process.env.PATH ?? "" };

/**
 * Resolves when the dashboard is quit, so the caller's `finally` runs and the
 * store is closed. Previously this resolved as soon as the first paint returned
 * and `q` called `process.exit` from inside the keypress handler, so nothing
 * ever closed the store and the WAL sidecars were always left behind.
 */
export async function runApp(options: AppOptions): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  try {
    await new Promise<void>((resolve) => {
      mountApp(renderer, options, resolve);
    });
  } finally {
    // Also covers a throw from the first paint, which happens inside mountApp:
    // without this the terminal is left in raw mode on the alt screen.
    renderer.destroy();
  }
}

/**
 * Mounts the dashboard onto a renderer. Split from `runApp` so tests can drive
 * it against the headless test renderer and assert the painted frame.
 *
 * `onQuit` lets the caller clean up rather than the handler calling
 * `process.exit` and skipping every `finally` on the way out.
 */
export function mountApp(
  renderer: CliRenderer,
  options: AppOptions,
  onQuit: () => void = () => process.exit(0),
): void {
  const view: ViewState = {
    prs: options.prs,
    grouped: true,
    filter: "",
    stackFocus: null,
    changedOnly: false,
    changedIds: new Set(options.changes.map((c) => c.prId)),
  };
  let lastSync = options.lastSync;
  let viewer = options.viewer;
  // A committed sync was whole by construction — partial ones are never
  // committed — so a launch read from the store starts with no failures.
  let failures: string[] = [];
  let baselineReset = options.baselineReset;
  let changed = byPr(options.changes);
  let cursor = 0;
  let scroll = 0;
  let filtering = false;
  let showHelp = false;
  let busy = false;
  let notice = "";
  let inflight: AbortController | null = null;

  // Direct renderables, not the `Text(...)` VNode helper: assigning `.content`
  // on a mounted VNode proxy does not propagate to the renderable.
  const header = new TextRenderable(renderer, { content: "" });
  const list = new TextRenderable(renderer, { content: "", flexGrow: 1 });
  const footer = new TextRenderable(renderer, { content: "" });
  renderer.root.add(header);
  renderer.root.add(list);
  renderer.root.add(footer);
  /** An unstyled chunk; StyledText only accepts chunks, never bare strings. */
  const plain = (text: string): TextChunk => stringToStyledText(text).chunks[0]!;

  const chunksFor = (row: Row, width: number, selected: boolean): TextChunk[] => {
    if (row.kind === "bucket") {
      return [bold(fg(COLOR.bucket)(`${row.label}  (${row.count})`))];
    }
    const { pr } = row;
    const seg = formatRow(pr, width);
    const moved = changed.get(pr.id);
    const mark = moved ? headline(moved) : undefined;
    return [
      selected ? fg(COLOR.cursor)("▸ ") : plain("  "),
      fg(VERDICT_COLOR[pr.verdict])(seg.badge),
      plain(" "),
      // OSC 8: the ref itself is the clickable link. `url` is null unless it
      // validated as https, so nothing unvetted reaches the escape sequence.
      pr.url === null ? dim(`${seg.ref} `) : dim(link(pr.url)(`${seg.ref} `)),
      pr.draft ? dim(seg.title) : plain(seg.title),
      plain("  "),
      // Ticket 0017 is open: a marker on the row is the smallest treatment, and
      // deliberately leaves the bucket structure untouched.
      mark === undefined
        ? plain("")
        : fg(COLOR.changed)(`[${label(mark.kind)}] `),
      dim(seg.meta),
    ];
  };

  function draw(): void {
    const width = renderer.terminalWidth;
    const rows = buildRows(view);
    const selectable = selectableIndices(rows);
    if (cursor >= selectable.length) cursor = Math.max(0, selectable.length - 1);

    const chromeLines = 2 + (failures.length > 0 ? failures.length : 0);
    const viewport = Math.max(3, renderer.terminalHeight - chromeLines);
    const cursorRow = selectable[cursor] ?? 0;
    if (cursorRow < scroll) scroll = cursorRow;
    if (cursorRow >= scroll + viewport) scroll = cursorRow - viewport + 1;
    scroll = Math.max(0, Math.min(scroll, Math.max(0, rows.length - viewport)));

    const present = new Set(view.prs.map((pr) => pr.id));
    const goneCount = [...changed.keys()].filter((id) => !present.has(id)).length;
    const age =
      lastSync === null ? "never synced" : busy ? "syncing…" : ageLabel(lastSync);
    const headerChunks: TextChunk[] = [
      bold(
        statusLine(view, selectable.length, {
          viewer,
          repos: options.repos.length,
          age,
          partial: failures.length > 0,
          changeCount: changed.size - goneCount,
          goneCount,
          baselineReset,
        }),
      ),
    ];
    for (const failure of failures) {
      headerChunks.push(plain("\n"), fg(COLOR.warn)(`  ! ${failure}`));
    }
    header.content = new StyledText(headerChunks);

    const body: TextChunk[] = [];
    if (rows.length === 0) {
      const filtered =
        view.filter !== "" || view.stackFocus !== null || view.changedOnly;
      body.push(dim(filtered ? "  nothing matches" : "  nothing to review"));
    }
    rows.slice(scroll, scroll + viewport).forEach((row, i) => {
      if (i > 0) body.push(plain("\n"));
      body.push(...chunksFor(row, width, scroll + i === cursorRow));
    });
    list.content = new StyledText(body);

    const hint = showHelp
      ? HELP
      : filtering
        ? `filter: ${view.filter}_  (enter to apply, esc to clear)`
        : notice || HELP;
    footer.content = new StyledText([dim(hint)]);
    renderer.requestRender();
  }

  function currentPr(): PullRequest | null {
    const rows = buildRows(view);
    const index = selectableIndices(rows)[cursor];
    const row = index === undefined ? undefined : rows[index];
    return row?.kind === "pr" ? row.pr : null;
  }

  async function sync(): Promise<void> {
    if (busy) {
      // A second press cancels the in-flight sync rather than being a no-op,
      // so a request stuck against a slow endpoint is escapable.
      inflight?.abort();
      return;
    }
    // The cursor is an ordinal, and a sync replaces the whole list — bucket
    // membership and sort both move on updatedAt. Pin to the PR under the
    // cursor so `o` cannot open something the driver never selected.
    const pinned = currentPr()?.id ?? null;
    const controller = new AbortController();
    inflight = controller;
    busy = true;
    notice = "";
    draw();
    try {
      const next = await options.sync(controller.signal);
      // Checked before the failure list: an abort that lands after one half has
      // already resolved arrives as a partial result, not as an error.
      if (controller.signal.aborted) {
        notice = "sync cancelled — baseline unchanged";
        return;
      }
      view.prs = next.prs;
      failures = next.failures;
      lastSync = next.at;
      viewer = next.viewer;
      baselineReset = next.baselineReset;
      changed = byPr(next.changes);
      view.changedIds = new Set(changed.keys());
      if (next.failures.length > 0) {
        notice = "sync incomplete — shown but not committed, baseline unchanged";
      } else if (next.baselineReset) {
        notice = "baseline set — the next sync will report what changed";
      } else {
        notice = `${changed.size} PR${changed.size === 1 ? "" : "s"} changed`;
      }
      if (pinned !== null) {
        const rows = buildRows(view);
        const at = selectableIndices(rows).findIndex((i) => {
          const row = rows[i];
          return row?.kind === "pr" && row.pr.id === pinned;
        });
        if (at >= 0) cursor = at;
      }
    } catch (error) {
      // `scan` collapses a total failure into a GitHubError, discarding the
      // AbortError identity — so the signal is the only reliable witness.
      notice = controller.signal.aborted
        ? "sync cancelled — baseline unchanged"
        : `sync failed: ${(error as Error).message}`;
    } finally {
      inflight = null;
      busy = false;
      draw();
    }
  }

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (filtering) {
      if (key.name === "return" || key.name === "escape") {
        if (key.name === "escape") view.filter = "";
        filtering = false;
      } else if (key.name === "backspace") {
        view.filter = view.filter.slice(0, -1);
      } else if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        view.filter += key.sequence;
      }
      cursor = 0;
      draw();
      return;
    }

    const rows = buildRows(view);
    const total = selectableIndices(rows).length;

    switch (key.name) {
      case "q":
        inflight?.abort();
        // Hand control back rather than calling process.exit here, which would
        // skip the caller's cleanup and leave the store open.
        onQuit();
        return;
      case "c":
        if (key.ctrl) {
          inflight?.abort();
          onQuit();
          return;
        }
        if (view.changedIds.size === 0) {
          notice = "nothing changed in the last sync";
          break;
        }
        view.changedOnly = !view.changedOnly;
        cursor = 0;
        break;
      case "j":
      case "down":
        cursor = Math.min(cursor + 1, Math.max(0, total - 1));
        break;
      case "k":
      case "up":
        cursor = Math.max(cursor - 1, 0);
        break;
      case "g":
        if (key.shift) {
          cursor = Math.max(0, total - 1);
        } else {
          view.grouped = !view.grouped;
          cursor = 0;
        }
        break;
      case "o": {
        const pr = currentPr();
        if (pr?.url == null) {
          notice = pr ? "no usable link for this PR" : "";
          break;
        }
        // A throw out of this listener is an uncaught exception that kills the
        // process without restoring the terminal.
        try {
          Bun.spawn(["open", "--", pr.url], {
            stdout: "ignore",
            stderr: "ignore",
            env: SPAWN_ENV,
          });
          notice = `opened ${pr.repo}#${pr.number}`;
        } catch (error) {
          notice = `could not open: ${(error as Error).message}`;
        }
        break;
      }
      case "y": {
        const pr = currentPr();
        if (pr?.url == null) {
          notice = pr ? "no usable link for this PR" : "";
          break;
        }
        try {
          const proc = Bun.spawn(["pbcopy"], { stdin: "pipe", env: SPAWN_ENV });
          proc.stdin.write(pr.url);
          proc.stdin.end();
          notice = `copied ${pr.url}`;
        } catch (error) {
          notice = `could not copy: ${(error as Error).message}`;
        }
        break;
      }
      case "s": {
        // Uppercase S syncs; lowercase s focuses a stack. Sync is deliberate, so
        // it does not share a keystroke with a navigation action.
        if (key.shift) {
          void sync();
          return;
        }
        if (view.stackFocus !== null) {
          view.stackFocus = null;
        } else {
          const pr = currentPr();
          if (pr?.stack) {
            view.stackFocus = pr.stack.number;
            notice = `stack ${pr.stack.number} — press s to leave`;
          } else {
            notice = "not in a stack";
          }
        }
        cursor = 0;
        break;
      }
      case "slash":
      case "/":
        filtering = true;
        view.filter = "";
        break;
      case "escape":
        view.filter = "";
        view.stackFocus = null;
        view.changedOnly = false;
        showHelp = false;
        notice = "";
        cursor = 0;
        break;
      case "?":
        showHelp = !showHelp;
        break;
      default:
        if (key.sequence === "/") {
          filtering = true;
          view.filter = "";
          break;
        }
        if (key.sequence === "?") {
          showHelp = !showHelp;
          break;
        }
        return;
    }
    draw();
  });

  renderer.on("resize", draw);
  draw();
}

function ageLabel(at: Date): string {
  const minutes = Math.floor((Date.now() - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  return `${minutes}m ago`;
}
