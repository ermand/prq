/**
 * Turning a scan into rows.
 *
 * Pure — no terminal, no colour. Layout and the stack treatment are prototype
 * choices feeding tickets 0011 and 0008; the bucket order and sorting they rest
 * on are settled (ticket 0007).
 */

import { flatten, groupIntoBuckets, type Bucket, type PullRequest } from "./domain";

export type Row =
  | { kind: "bucket"; label: string; count: number }
  | { kind: "pr"; pr: PullRequest };

export interface ViewState {
  prs: PullRequest[];
  grouped: boolean;
  filter: string;
  /** Show only members of this stack, by stack number. */
  stackFocus: number | null;
}

export function matchesFilter(pr: PullRequest, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle === "") return true;
  return (
    pr.title.toLowerCase().includes(needle) ||
    pr.repo.toLowerCase().includes(needle) ||
    pr.author.toLowerCase().includes(needle) ||
    String(pr.number).includes(needle)
  );
}

export function visiblePrs(state: ViewState): PullRequest[] {
  return state.prs.filter(
    (pr) =>
      matchesFilter(pr, state.filter) &&
      (state.stackFocus === null || pr.stack?.number === state.stackFocus),
  );
}

export function buildRows(state: ViewState): Row[] {
  const visible = visiblePrs(state);
  if (!state.grouped) {
    return flatten(visible).map((pr) => ({ kind: "pr", pr }) as const);
  }
  return groupIntoBuckets(visible).flatMap((bucket: Bucket) => [
    { kind: "bucket", label: bucket.label, count: bucket.items.length } as const,
    ...bucket.items.map((pr) => ({ kind: "pr", pr }) as const),
  ]);
}

/** Indices into `rows` that the cursor may land on. Bucket headers are skipped. */
export function selectableIndices(rows: Row[]): number[] {
  return rows.reduce<number[]>((acc, row, i) => {
    if (row.kind === "pr") acc.push(i);
    return acc;
  }, []);
}

const VERDICT_BADGE: Record<PullRequest["verdict"], string> = {
  approved: "APPR",
  "changes-requested": "CHNG",
  "awaiting-review": "NEW ",
  "review-optional": "OPEN",
};

const CHECK_GLYPH: Record<PullRequest["checks"], string> = {
  success: "+",
  failing: "x",
  pending: "~",
  none: " ",
};

export function relativeAge(iso: string, now = new Date()): string {
  const minutes = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 365) return `${Math.floor(days)}d`;
  return `${Math.floor(days / 365)}y`;
}

export interface RowSegments {
  badge: string;
  /** Repo and number, trimmed of the owner when it is unambiguous. */
  ref: string;
  title: string;
  meta: string;
}

/**
 * Composes one PR row. `title` absorbs the remaining width, so an 80-column
 * terminal drops title text before it drops any state.
 */
export function formatRow(
  pr: PullRequest,
  width: number,
  now = new Date(),
): RowSegments {
  const ref = `${pr.repo.split("/")[1] ?? pr.repo}#${pr.number}`;
  const marks = [
    CHECK_GLYPH[pr.checks],
    pr.merge === "conflicted" ? "!" : " ",
    pr.stack ? `${pr.stack.position}/${pr.stack.size}` : "",
  ]
    .join("")
    .trimEnd();

  const meta = [marks, pr.author, relativeAge(pr.updatedAt, now)]
    .filter((part) => part !== "")
    .join(" ");

  const badge = VERDICT_BADGE[pr.verdict];
  // 2 leading, 1 after badge, 1 after ref, 2 before meta.
  const spent = 2 + badge.length + 1 + ref.length + 1 + 2 + meta.length;
  const room = Math.max(8, width - spent);
  // Split by code point: slicing UTF-16 units mid-surrogate leaves a lone half
  // that the terminal renders as replacement junk.
  const glyphs = [...pr.title];
  const title =
    glyphs.length > room ? `${glyphs.slice(0, room - 1).join("")}…` : pr.title;
  return { badge, ref, title, meta };
}

export function statusLine(
  state: ViewState,
  rowCount: number,
  extras: { viewer: string; repos: number; age: string; partial: boolean },
): string {
  const parts = [
    extras.viewer,
    `${rowCount} PR${rowCount === 1 ? "" : "s"}`,
    `${extras.repos} repo${extras.repos === 1 ? "" : "s"}`,
    extras.age,
  ];
  if (!state.grouped) parts.push("flat");
  if (state.stackFocus !== null) parts.push(`stack ${state.stackFocus}`);
  if (state.filter !== "") parts.push(`/${state.filter}`);
  if (extras.partial) parts.push("INCOMPLETE");
  return parts.join(" · ");
}
