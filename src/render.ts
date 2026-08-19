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
  stackFocus: string | null;
  /** Show only PRs that moved in the last sync. */
  changedOnly: boolean;
  /** Ids that moved in the last sync; consulted when `changedOnly` is set. */
  changedIds: ReadonlySet<string>;
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
      (state.stackFocus === null || pr.stacks.some((s) => s.id === state.stackFocus)) &&
      (!state.changedOnly || state.changedIds.has(pr.id)),
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
  // The last segment, not the second: GitLab paths nest, so `[1]` rendered
  // `group/subgroup/project` as `subgroup#42` — and a project at
  // `anything/facebook/react` would have aliased the GitHub repo of that name in
  // this shared list. The provider prefix makes the two namespaces
  // unconfusable at a glance.
  const project = pr.repo.split("/").at(-1) ?? pr.repo;
  const ref = `${pr.provider === "gitlab" ? "gl:" : ""}${project}#${pr.number}`;
  const marks = [
    CHECK_GLYPH[pr.checks],
    pr.merge === "conflicted" ? "!" : " ",
    // `~` marks an approximate count: GitLab lists only open layers, so it cannot
    // express a partly-landed 5/6 the way GitHub can.
    pr.stacks
      .map((s) => `${s.position}/${s.size}${s.precision === "approximate" ? "~" : ""}`)
      .join(" "),
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
  extras: {
    viewer: string;
    repos: number;
    age: string;
    partial: boolean;
    /** Changed PRs that have a row to show. */
    changeCount: number;
    /** Changed PRs that have left the set, and so have no row. */
    goneCount: number;
    baselineReset: boolean;
  },
): string {
  const parts = [
    extras.viewer || "not synced",
    `${rowCount} PR${rowCount === 1 ? "" : "s"}`,
    `${extras.repos} repo${extras.repos === 1 ? "" : "s"}`,
    extras.age,
  ];
  if (extras.changeCount > 0) {
    parts.push(`${extras.changeCount} changed`);
  }
  if (extras.goneCount > 0) {
    // Never folded into `changeCount`: these have no row, so promising them in
    // the same number the changed-only filter narrows to would be a lie.
    parts.push(`${extras.goneCount} gone`);
  }
  if (extras.changeCount === 0 && extras.goneCount === 0 && extras.baselineReset) {
    // A first sync has no predecessor, so "0 changed" would imply nothing moved
    // when the truth is that nothing could be compared.
    parts.push("baseline set");
  }
  if (!state.grouped) parts.push("flat");
  if (state.changedOnly) parts.push("changed only");
  // The key is a provider node id, which is long and meaningless on screen.
  if (state.stackFocus !== null) parts.push("one stack");
  if (state.filter !== "") parts.push(`/${state.filter}`);
  if (extras.partial) parts.push("INCOMPLETE — not committed");
  return parts.join(" · ");
}
