/**
 * What changed between two syncs.
 *
 * Pure: two sets of pull requests in, a list of changes out. No storage, no
 * clock, no I/O — the store persists what this returns.
 *
 * Which axes are reported is wayfinder ticket 0015, still open; this set is a
 * prototype choice. The axes chosen deliberately avoid firing on a bare push,
 * because 8 of 14 PRs awaiting the driver's review are Dependabot bumps and a
 * push-triggered axis would be nothing but bots.
 */

import { bucketOf, type PullRequest } from "./domain";

export type ChangeKind =
  /** Now concerns the viewer and did not at the previous sync. */
  | "joined"
  /** Gone from the set — merged, closed, or involvement ended. */
  | "left"
  /** Pushed to while the viewer's changes-request stood. */
  | "pushed-while-blocked"
  /** Base branch moved. The API marks this in no other way. */
  | "retargeted"
  /** A review is now requested of the viewer. */
  | "review-requested"
  | "verdict"
  | "checks"
  | "merge"
  /** Draft became ready for review. */
  | "ready"
  /** Moved between relevance buckets. */
  | "bucket";

export interface Change {
  prId: string;
  kind: ChangeKind;
  from: string | null;
  to: string | null;
}

/**
 * Significance order, most urgent first. Used to pick a single headline change
 * when a PR moved on several axes at once.
 */
export const KIND_ORDER: readonly ChangeKind[] = [
  "review-requested",
  "pushed-while-blocked",
  "retargeted",
  "joined",
  "left",
  "verdict",
  "ready",
  "merge",
  "checks",
  "bucket",
];

const RANK: Record<ChangeKind, number> = KIND_ORDER.reduce<Record<string, number>>(
  (acc, kind, i) => {
    acc[kind] = i;
    return acc;
  },
  {},
) as Record<ChangeKind, number>;

/**
 * Membership test for a kind read back off disk. Migration deliberately keeps
 * change history across schema versions, so an obsolete kind is an expected
 * input rather than a hypothetical — and `Object.hasOwn` matters here because a
 * bare `in` would accept `constructor` and friends off the prototype chain.
 */
export function isChangeKind(value: unknown): value is ChangeKind {
  return typeof value === "string" && Object.hasOwn(RANK, value);
}

/** The single most significant change for a PR, or undefined if it did not move. */
export function headline(changes: Change[]): Change | undefined {
  return changes.reduce<Change | undefined>(
    (best, change) =>
      best === undefined || RANK[change.kind] < RANK[best.kind] ? change : best,
    undefined,
  );
}

/**
 * `previous` is the state committed by the last successful sync; `current` is
 * what this sync fetched. A first sync has no previous state, and the caller
 * must not treat every PR as `joined` — see `diff`'s contract below.
 */
export function diff(previous: PullRequest[], current: PullRequest[]): Change[] {
  const before = new Map(previous.map((pr) => [pr.id, pr]));
  const after = new Map(current.map((pr) => [pr.id, pr]));
  const changes: Change[] = [];

  for (const pr of current) {
    const was = before.get(pr.id);
    if (was === undefined) {
      changes.push({ prId: pr.id, kind: "joined", from: null, to: pr.repo });
      continue;
    }

    // A push only matters while the viewer is blocking: it is the signal that
    // the author has addressed the review and is waiting, unaware.
    if (was.headOid !== pr.headOid && pr.standing === "i-requested-changes") {
      changes.push({
        kind: "pushed-while-blocked",
        prId: pr.id,
        from: was.headOid,
        to: pr.headOid,
      });
    }

    if (was.baseRef !== pr.baseRef) {
      changes.push({
        kind: "retargeted",
        prId: pr.id,
        from: was.baseRef,
        to: pr.baseRef,
      });
    }

    if (was.standing !== "awaiting-me" && pr.standing === "awaiting-me") {
      changes.push({
        kind: "review-requested",
        prId: pr.id,
        from: was.standing,
        to: pr.standing,
      });
    }

    if (was.verdict !== pr.verdict) {
      changes.push({ kind: "verdict", prId: pr.id, from: was.verdict, to: pr.verdict });
    }

    // Two fields resolve lazily and must not fire on the API catching up.
    // Both guards are **directional**: only a transition towards the
    // uninformative value, or away from it towards the benign one, is
    // suppressed. A transition to a *blocking* value is real news.
    //
    // `mergeable` returns UNKNOWN whenever the base moves, so
    // `unknown → conflicted` is the ordinary shape of a genuine conflict
    // arising between two syncs — suppressing it would silently hide a PR
    // sliding from "ready to land" into "needs work".
    const suppressMerge =
      pr.merge === "unknown" || (was.merge === "unknown" && pr.merge === "clean");

    // `statusCheckRollup` is null until the first check run exists on the head
    // commit, so `none` means both "no CI configured" and "pushed seconds ago".
    // `none ↔ pending` is therefore noise; every real red/green transition still
    // reports, including `none → failing`.
    const suppressChecks =
      (was.checks === "none" && pr.checks === "pending") ||
      (was.checks === "pending" && pr.checks === "none");

    if (!suppressChecks && was.checks !== pr.checks) {
      changes.push({ kind: "checks", prId: pr.id, from: was.checks, to: pr.checks });
    }

    if (!suppressMerge && was.merge !== pr.merge) {
      changes.push({ kind: "merge", prId: pr.id, from: was.merge, to: pr.merge });
    }

    if (was.draft && !pr.draft) {
      changes.push({ kind: "ready", prId: pr.id, from: "draft", to: "ready" });
    }

    // Compare buckets on equal footing: where a field's movement was suppressed
    // as noise, substitute the current value so a bucket move driven purely by
    // that resolution does not fire either.
    const comparable = {
      ...was,
      merge: suppressMerge ? pr.merge : was.merge,
      checks: suppressChecks ? pr.checks : was.checks,
    };
    const wasBucket = bucketOf(comparable);
    const nowBucket = bucketOf(pr);
    if (wasBucket !== nowBucket) {
      changes.push({
        kind: "bucket",
        prId: pr.id,
        from: String(wasBucket),
        to: String(nowBucket),
      });
    }
  }

  for (const pr of previous) {
    if (!after.has(pr.id)) {
      // Only observable from history: the scan asks for open PRs, so a merged
      // one simply stops appearing and no single scan can tell that from
      // "never matched".
      changes.push({ kind: "left", prId: pr.id, from: pr.repo, to: null });
    }
  }

  return changes;
}

/** Groups changes by PR, preserving the order `diff` produced. */
export function byPr(changes: Change[]): Map<string, Change[]> {
  const grouped = new Map<string, Change[]>();
  for (const change of changes) {
    const existing = grouped.get(change.prId);
    if (existing) existing.push(change);
    else grouped.set(change.prId, [change]);
  }
  return grouped;
}

const LABELS: Record<ChangeKind, string> = {
  joined: "new",
  left: "gone",
  "pushed-while-blocked": "addressed",
  retargeted: "retargeted",
  "review-requested": "asked",
  verdict: "verdict",
  checks: "ci",
  merge: "merge",
  ready: "ready",
  bucket: "moved",
};

export function label(kind: ChangeKind): string {
  return LABELS[kind];
}
