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

const COLOR = {
  approved: "#7ee787",
  changes: "#ff7b72",
  awaiting: "#79c0ff",
  optional: "#8b949e",
  bucket: "#d2a8ff",
  cursor: "#1f6feb",
  warn: "#f0883e",
} as const;

const VERDICT_COLOR: Record<PullRequest["verdict"], string> = {
  approved: COLOR.approved,
  "changes-requested": COLOR.changes,
  "awaiting-review": COLOR.awaiting,
  "review-optional": COLOR.optional,
};

export interface AppOptions {
  prs: PullRequest[];
  viewer: string;
  repos: string[];
  fetchedAt: Date;
  partial: boolean;
  failures: string[];
  refresh: (signal: AbortSignal) => Promise<{
    prs: PullRequest[];
    partial: boolean;
    failures: string[];
    fetchedAt: Date;
  }>;
}

const HELP =
  "j/k move · o open · y copy · s stack · g group · / filter · r refresh · ? help · q quit";

/**
 * Child processes get PATH and nothing else. `open` and `pbcopy` have no use
 * for a repo-scoped GitHub token, and Bun.spawn inherits the full environment
 * by default.
 */
const SPAWN_ENV = { PATH: process.env.PATH ?? "" };

export async function runApp(options: AppOptions): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  try {
    mountApp(renderer, options);
  } catch (error) {
    // The first paint happens inside mountApp. Without this the terminal is
    // left in raw mode on the alt screen with the cursor hidden.
    renderer.destroy();
    throw error;
  }
}

/**
 * Mounts the dashboard onto a renderer. Split from `runApp` so tests can drive
 * it against the headless test renderer and assert the painted frame.
 */
export function mountApp(renderer: CliRenderer, options: AppOptions): void {

  const view: ViewState = {
    prs: options.prs,
    grouped: true,
    filter: "",
    stackFocus: null,
  };
  let fetchedAt = options.fetchedAt;
  let partial = options.partial;
  let failures = options.failures;
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
    return [
      selected ? fg(COLOR.cursor)("▸ ") : plain("  "),
      fg(VERDICT_COLOR[pr.verdict])(seg.badge),
      plain(" "),
      // OSC 8: the ref itself is the clickable link. `url` is null unless it
      // validated as https, so nothing unvetted reaches the escape sequence.
      pr.url === null ? dim(`${seg.ref} `) : dim(link(pr.url)(`${seg.ref} `)),
      pr.draft ? dim(seg.title) : plain(seg.title),
      plain("  "),
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

    const age = ageLabel(fetchedAt);
    const headerChunks: TextChunk[] = [
      bold(
        statusLine(view, selectable.length, {
          viewer: options.viewer,
          repos: options.repos.length,
          age: busy ? "scanning…" : age,
          partial,
        }),
      ),
    ];
    for (const failure of failures) {
      headerChunks.push(plain("\n"), fg(COLOR.warn)(`  ! ${failure}`));
    }
    header.content = new StyledText(headerChunks);

    const body: TextChunk[] = [];
    if (rows.length === 0) {
      body.push(dim(view.filter || view.stackFocus !== null ? "  nothing matches" : "  nothing to review"));
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

  async function refresh(): Promise<void> {
    if (busy) {
      // A second `r` cancels the in-flight scan rather than being a no-op,
      // so a request stuck against a slow endpoint is escapable.
      inflight?.abort();
      return;
    }
    // The cursor is an ordinal, and a refresh replaces the whole list — bucket
    // membership and sort both move on updatedAt. Pin to the PR under the
    // cursor so `o` cannot open something the user never selected.
    const pinned = currentPr()?.id ?? null;
    inflight = new AbortController();
    busy = true;
    notice = "";
    draw();
    try {
      const next = await options.refresh(inflight.signal);
      view.prs = next.prs;
      partial = next.partial;
      failures = next.failures;
      fetchedAt = next.fetchedAt;
      if (pinned !== null) {
        const rows = buildRows(view);
        const at = selectableIndices(rows).findIndex((i) => {
          const row = rows[i];
          return row?.kind === "pr" && row.pr.id === pinned;
        });
        if (at >= 0) cursor = at;
      }
    } catch (error) {
      notice =
        (error as Error).name === "AbortError"
          ? "refresh cancelled"
          : `refresh failed: ${(error as Error).message}`;
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
        renderer.destroy();
        process.exit(0);
        return;
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
        showHelp = false;
        notice = "";
        cursor = 0;
        break;
      case "r":
        void refresh();
        return;
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
