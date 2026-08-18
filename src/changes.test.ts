import { describe, expect, test } from "bun:test";
import {
  byPr,
  diff,
  headline,
  isChangeKind,
  KIND_ORDER,
  label,
  type Change,
} from "./changes";
import { normalize, type PullRequest, type RawPullRequest } from "./domain";

function pr(over: Partial<PullRequest> = {}): PullRequest {
  const base = normalize(
    {
      id: "PR_1",
      number: 1,
      title: "A change",
      url: "https://github.com/org/repo/pull/1",
      isDraft: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      headRefOid: "0".repeat(40),
      baseRefName: "main",
      mergeable: "MERGEABLE",
      reviewDecision: "REVIEW_REQUIRED",
      author: { login: "alice" },
      repository: { nameWithOwner: "org/repo" },
      viewerDidAuthor: false,
      viewerLatestReview: null,
      viewerLatestReviewRequest: null,
      latestOpinionatedReviews: { nodes: [] },
      stack: null,
      stackEntry: null,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    } satisfies RawPullRequest,
    "ermand",
  );
  return { ...base, ...over };
}

const kinds = (changes: Change[]) => changes.map((c) => c.kind).sort();

describe("membership", () => {
  test("a PR absent before is joined", () => {
    expect(kinds(diff([], [pr()]))).toEqual(["joined"]);
  });

  test("a PR absent after has left", () => {
    // Only observable from history: the scan asks is:open, so a merged PR just
    // stops appearing and no single scan can distinguish that from never matching.
    expect(kinds(diff([pr()], []))).toEqual(["left"]);
  });

  test("an unchanged PR yields nothing", () => {
    const p = pr();
    expect(diff([p], [{ ...p }])).toEqual([]);
  });

  test("a joined PR reports only joining, not every field as a change", () => {
    // Otherwise a first sight of a PR emits ten changes at once.
    expect(kinds(diff([], [pr({ verdict: "approved", checks: "failing" })]))).toEqual([
      "joined",
    ]);
  });
});

describe("pushes", () => {
  test("a push while blocking is reported", () => {
    const was = pr({ standing: "i-requested-changes", headOid: "1".repeat(40) });
    const now = pr({ standing: "i-requested-changes", headOid: "2".repeat(40) });
    expect(kinds(diff([was], [now]))).toContain("pushed-while-blocked");
  });

  test("a push with no block of mine is silent", () => {
    // The bot-noise guard: 8 of 14 PRs awaiting review are Dependabot bumps and
    // they push often. Firing on every push would report nothing but bots.
    const was = pr({ standing: "not-involved", headOid: "1".repeat(40) });
    const now = pr({ standing: "not-involved", headOid: "2".repeat(40) });
    expect(diff([was], [now])).toEqual([]);
  });

  test("a push while awaiting my review is silent", () => {
    const was = pr({ standing: "awaiting-me", headOid: "1".repeat(40) });
    const now = pr({ standing: "awaiting-me", headOid: "2".repeat(40) });
    expect(diff([was], [now])).toEqual([]);
  });
});

describe("retargeting", () => {
  test("a base branch change is reported", () => {
    // The reason a store exists: the API marks this in no other way.
    const changes = diff([pr({ baseRef: "feature/a" })], [pr({ baseRef: "main" })]);
    const retarget = changes.find((c) => c.kind === "retargeted");
    expect(retarget).toBeDefined();
    expect(retarget?.from).toBe("feature/a");
    expect(retarget?.to).toBe("main");
  });
});

describe("review requests", () => {
  test("becoming awaiting-me is reported", () => {
    const changes = diff(
      [pr({ standing: "not-involved" })],
      [pr({ standing: "awaiting-me" })],
    );
    expect(kinds(changes)).toContain("review-requested");
  });

  test("already awaiting-me is not re-reported", () => {
    const changes = diff([pr({ standing: "awaiting-me" })], [pr({ standing: "awaiting-me" })]);
    expect(kinds(changes)).not.toContain("review-requested");
  });

  test("ceasing to await me is not a review request", () => {
    const changes = diff(
      [pr({ standing: "awaiting-me" })],
      [pr({ standing: "i-approved" })],
    );
    expect(kinds(changes)).not.toContain("review-requested");
  });
});

describe("field movements", () => {
  test("verdict, checks and merge flips are each reported", () => {
    const was = pr({ verdict: "awaiting-review", checks: "pending", merge: "clean" });
    const now = pr({ verdict: "approved", checks: "success", merge: "conflicted" });
    const k = kinds(diff([was], [now]));
    expect(k).toContain("verdict");
    expect(k).toContain("checks");
    expect(k).toContain("merge");
  });

  test("draft becoming ready is reported, but not the reverse", () => {
    expect(kinds(diff([pr({ draft: true })], [pr({ draft: false })]))).toContain("ready");
    expect(kinds(diff([pr({ draft: false })], [pr({ draft: true })]))).not.toContain(
      "ready",
    );
  });

  test("a bucket move is reported", () => {
    const was = pr({ standing: "not-involved" });
    const now = pr({ standing: "awaiting-me" });
    expect(kinds(diff([was], [now]))).toContain("bucket");
  });

  test("carries the from and to values", () => {
    const change = diff([pr({ checks: "success" })], [pr({ checks: "failing" })]).find(
      (c) => c.kind === "checks",
    );
    expect(change?.from).toBe("success");
    expect(change?.to).toBe("failing");
  });
});

describe("headline", () => {
  test("picks the most significant of several", () => {
    const was = pr({ standing: "not-involved", checks: "success", verdict: "awaiting-review" });
    const now = pr({ standing: "awaiting-me", checks: "failing", verdict: "approved" });
    const changes = diff([was], [now]);
    expect(changes.length).toBeGreaterThan(1);
    expect(headline(changes)?.kind).toBe("review-requested");
  });

  test("a retarget outranks a mere bucket move", () => {
    const changes: Change[] = [
      { prId: "a", kind: "bucket", from: "7", to: "1" },
      { prId: "a", kind: "retargeted", from: "x", to: "y" },
    ];
    expect(headline(changes)?.kind).toBe("retargeted");
  });

  test("is undefined for no changes", () => {
    expect(headline([])).toBeUndefined();
  });

  test("every kind has a rank and a label", () => {
    // Guards against a new kind being added without a place in the order.
    for (const kind of KIND_ORDER) expect(label(kind)).toBeTruthy();
    expect(new Set(KIND_ORDER).size).toBe(KIND_ORDER.length);
  });
});

describe("byPr", () => {
  test("groups every change under its PR", () => {
    const was = pr({ standing: "not-involved", checks: "success" });
    const now = pr({ standing: "awaiting-me", checks: "failing" });
    const grouped = byPr(diff([was], [now]));
    expect(grouped.size).toBe(1);
    expect(grouped.get("PR_1")!.length).toBeGreaterThan(1);
  });

  test("keeps PRs apart", () => {
    const grouped = byPr(
      diff([], [pr({ id: "A", number: 1 }), pr({ id: "B", number: 2 })]),
    );
    expect([...grouped.keys()].sort()).toEqual(["A", "B"]);
  });
});

describe("lazily resolved fields", () => {
  test("unknown resolving to clean is not a change", () => {
    // GitHub computes mergeable on demand: a first sync sees UNKNOWN and the
    // next sees the real value. Observed live — 29 PRs synced twice, seconds
    // apart, produced 19 spurious merge transitions before this guard.
    expect(diff([pr({ merge: "unknown" })], [pr({ merge: "clean" })])).toEqual([]);
  });

  test("unknown resolving to CONFLICTED is very much a change", () => {
    // The guard must be directional. `mergeable` returns to UNKNOWN whenever the
    // base moves, so unknown → conflicted is the ordinary shape of a real
    // conflict arising between syncs. Suppressing it would silently hide a PR
    // sliding out of "ready to land" into "needs work".
    expect(kinds(diff([pr({ merge: "unknown" })], [pr({ merge: "conflicted" })]))).toContain(
      "merge",
    );
  });

  test("losing a known merge state is not a change", () => {
    expect(diff([pr({ merge: "clean" })], [pr({ merge: "unknown" })])).toEqual([]);
  });

  test("a real merge transition between known states still reports", () => {
    expect(kinds(diff([pr({ merge: "clean" })], [pr({ merge: "conflicted" })]))).toEqual([
      "merge",
    ]);
  });

  test("a bucket move caused only by resolving to clean does not fire", () => {
    // The 4 bucket moves that accompanied those 19 merge transitions: PRs slid
    // into "Mine, ready to land" once mergeability resolved.
    const approved = { standing: "mine", verdict: "approved", checks: "success" } as const;
    expect(
      diff([pr({ ...approved, merge: "unknown" })], [pr({ ...approved, merge: "clean" })]),
    ).toEqual([]);
  });

  test("a bucket move caused by starting to conflict does fire", () => {
    const approved = { standing: "mine", verdict: "approved", checks: "success" } as const;
    const k = kinds(
      diff(
        [pr({ ...approved, merge: "unknown" })],
        [pr({ ...approved, merge: "conflicted" })],
      ),
    );
    expect(k).toContain("bucket");
    expect(k).toContain("merge");
  });

  test("a genuine bucket move fires alongside a suppressed merge resolution", () => {
    const before = pr({ standing: "not-involved", merge: "unknown" });
    const after = pr({ standing: "awaiting-me", merge: "clean" });
    const k = kinds(diff([before], [after]));
    expect(k).toContain("bucket");
    expect(k).toContain("review-requested");
    expect(k).not.toContain("merge");
  });

  test("checks none and pending are interchangeable noise", () => {
    // `statusCheckRollup` is null until the first check run exists on the head
    // commit, so `none` also means "pushed seconds ago". With most of the review
    // queue being Dependabot bumps that push often, firing here would be bots
    // only.
    expect(diff([pr({ checks: "none" })], [pr({ checks: "pending" })])).toEqual([]);
    expect(diff([pr({ checks: "pending" })], [pr({ checks: "none" })])).toEqual([]);
  });

  test("every real red or green transition still reports", () => {
    for (const [was, now] of [
      ["none", "failing"],
      ["none", "success"],
      ["pending", "failing"],
      ["pending", "success"],
      ["success", "failing"],
      ["failing", "success"],
    ] as const) {
      expect(kinds(diff([pr({ checks: was })], [pr({ checks: now })]))).toContain("checks");
    }
  });

  test("a bucket move caused only by none to pending does not fire", () => {
    // `pending` disqualifies bucket 3 while `none` does not, so this was the
    // same double-fire the merge guard exists to prevent.
    const approved = { standing: "mine", verdict: "approved", merge: "clean" } as const;
    expect(
      diff(
        [pr({ ...approved, checks: "none" })],
        [pr({ ...approved, checks: "pending" })],
      ),
    ).toEqual([]);
  });
});

describe("isChangeKind", () => {
  test("accepts every real kind", () => {
    for (const kind of KIND_ORDER) expect(isChangeKind(kind)).toBe(true);
  });

  test("rejects an obsolete kind and prototype keys", () => {
    // Migration deliberately keeps history across schema versions, so an
    // obsolete kind is expected input. `constructor` would pass a bare `in`.
    expect(isChangeKind("totally-bogus")).toBe(false);
    expect(isChangeKind("constructor")).toBe(false);
    expect(isChangeKind("toString")).toBe(false);
    expect(isChangeKind(undefined)).toBe(false);
  });
});
