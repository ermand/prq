import { describe, expect, test } from "bun:test";
import {
  bucketOf,
  compareWithin,
  flatten,
  groupIntoBuckets,
  isPullRequest,
  isStaleBlock,
  normalize,
  safeUrl,
  sanitize,
  standingOf,
  toChecks,
  toMergeState,
  toVerdict,
  type PullRequest,
  type RawPullRequest,
  type RawReview,
} from "./domain";

const VIEWER = "ermand";
const HEAD = "headsha";

function review(
  login: string,
  state: string,
  oid: string | null = HEAD,
): RawReview {
  return { state, author: { login }, commit: oid ? { oid } : null };
}

function raw(over: Partial<RawPullRequest> = {}): RawPullRequest {
  return {
    id: "PR_1",
    number: 1,
    title: "A change",
    url: "https://github.com/o/r/pull/1",
    isDraft: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    headRefOid: HEAD,
    mergeable: "MERGEABLE",
    reviewDecision: "REVIEW_REQUIRED",
    author: { login: "someone" },
    repository: { nameWithOwner: "o/r" },
    viewerDidAuthor: false,
    viewerLatestReview: null,
    viewerLatestReviewRequest: null,
    latestOpinionatedReviews: { nodes: [] },
    stack: null,
    stackEntry: null,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    ...over,
  };
}

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return { ...normalize(raw(), VIEWER), ...over };
}

describe("verdict", () => {
  test("null is review-optional, not awaiting-review", () => {
    // The repository does not require review — nobody is being waited on.
    expect(toVerdict(null)).toBe("review-optional");
    expect(toVerdict("REVIEW_REQUIRED")).toBe("awaiting-review");
  });

  test("maps the enum GitHub actually returns", () => {
    expect(toVerdict("APPROVED")).toBe("approved");
    expect(toVerdict("CHANGES_REQUESTED")).toBe("changes-requested");
  });
});

describe("readiness", () => {
  test("ERROR counts as failing, EXPECTED as pending", () => {
    expect(toChecks("ERROR")).toBe("failing");
    expect(toChecks("FAILURE")).toBe("failing");
    expect(toChecks("EXPECTED")).toBe("pending");
    expect(toChecks("PENDING")).toBe("pending");
    expect(toChecks("SUCCESS")).toBe("success");
  });

  test("absent rollup is none, not failing", () => {
    // A repo with no CI must not look broken.
    expect(toChecks(null)).toBe("none");
    expect(toChecks(undefined)).toBe("none");
  });

  test("UNKNOWN mergeability is unknown, not conflicted", () => {
    // GitHub computes mergeability lazily; first sight can be UNKNOWN.
    expect(toMergeState("UNKNOWN")).toBe("unknown");
    expect(toMergeState(null)).toBe("unknown");
    expect(toMergeState("CONFLICTING")).toBe("conflicted");
  });
});

describe("standing", () => {
  test("a later comment does not withdraw my block", () => {
    // The bug this test exists to prevent: viewerLatestReview says COMMENTED
    // while the opinionated review still says CHANGES_REQUESTED. Reading the
    // former downgrades a live block to Ambient. Observed on oven-sh/bun#36831.
    const masked = raw({
      viewerLatestReview: { state: "COMMENTED" },
      latestOpinionatedReviews: {
        nodes: [review(VIEWER, "CHANGES_REQUESTED")],
      },
    });
    expect(standingOf(masked, VIEWER)).toBe("i-requested-changes");
  });

  test("authorship beats everything", () => {
    const mine = raw({
      viewerDidAuthor: true,
      viewerLatestReviewRequest: { asCodeOwner: false },
    });
    expect(standingOf(mine, VIEWER)).toBe("mine");
  });

  test("a live request outranks my prior opinion", () => {
    // The re-request case: I reviewed, they pushed, they asked again.
    const reRequested = raw({
      viewerLatestReviewRequest: { asCodeOwner: false },
      latestOpinionatedReviews: {
        nodes: [review(VIEWER, "CHANGES_REQUESTED", "older")],
      },
    });
    expect(standingOf(reRequested, VIEWER)).toBe("awaiting-me");
  });

  test("another reviewer's opinion is not mine", () => {
    const theirs = raw({
      latestOpinionatedReviews: { nodes: [review("someone", "APPROVED")] },
    });
    expect(standingOf(theirs, VIEWER)).toBe("not-involved");
  });

  test("comment with no opinion is i-commented", () => {
    const commented = raw({ viewerLatestReview: { state: "COMMENTED" } });
    expect(standingOf(commented, VIEWER)).toBe("i-commented");
  });
});

describe("stale block", () => {
  test("is true only when the head moved past my changes-request", () => {
    const moved = raw({
      latestOpinionatedReviews: {
        nodes: [review(VIEWER, "CHANGES_REQUESTED", "older")],
      },
    });
    const unchanged = raw({
      latestOpinionatedReviews: {
        nodes: [review(VIEWER, "CHANGES_REQUESTED", HEAD)],
      },
    });
    expect(isStaleBlock(moved, VIEWER)).toBe(true);
    expect(isStaleBlock(unchanged, VIEWER)).toBe(false);
  });

  test("an approval of mine is never a stale block", () => {
    const approved = raw({
      latestOpinionatedReviews: { nodes: [review(VIEWER, "APPROVED", "older")] },
    });
    expect(isStaleBlock(approved, VIEWER)).toBe(false);
  });

  test("a blocking review whose commit is gone counts as stale", () => {
    // A null commit almost always means the author force-pushed, which is
    // exactly the stale case. Reading it as "unchanged" hides the most
    // actionable state on the board inside the bucket that means "nothing
    // has happened".
    const forcePushed = raw({
      latestOpinionatedReviews: {
        nodes: [review(VIEWER, "CHANGES_REQUESTED", null)],
      },
    });
    expect(isStaleBlock(forcePushed, VIEWER)).toBe(true);
    expect(bucketOf(normalize(forcePushed, VIEWER))).toBe(2);
  });
});

describe("buckets", () => {
  test("a stale block lands in 2, an unchanged one in 6", () => {
    expect(
      bucketOf(pr({ standing: "i-requested-changes", staleBlock: true })),
    ).toBe(2);
    expect(
      bucketOf(pr({ standing: "i-requested-changes", staleBlock: false })),
    ).toBe(6);
  });

  test("a re-requested stale block is bucket 1, not 2", () => {
    // Precedence: a live request outranks my stale opinion.
    const reRequested = normalize(
      raw({
        viewerLatestReviewRequest: { asCodeOwner: false },
        latestOpinionatedReviews: {
          nodes: [review(VIEWER, "CHANGES_REQUESTED", "older")],
        },
      }),
      VIEWER,
    );
    expect(bucketOf(reRequested)).toBe(1);
  });

  test("my own PRs split by readiness", () => {
    const mine = { standing: "mine" } as const;
    expect(
      bucketOf(pr({ ...mine, verdict: "approved", checks: "success", merge: "clean" })),
    ).toBe(3);
    expect(bucketOf(pr({ ...mine, verdict: "changes-requested" }))).toBe(4);
    expect(bucketOf(pr({ ...mine, checks: "failing" }))).toBe(4);
    expect(bucketOf(pr({ ...mine, merge: "conflicted" }))).toBe(4);
    expect(bucketOf(pr({ ...mine, checks: "pending" }))).toBe(5);
    expect(bucketOf(pr({ ...mine, verdict: "awaiting-review" }))).toBe(5);
  });

  test("approved but failing is needs-work, not ready-to-land", () => {
    expect(
      bucketOf(pr({ standing: "mine", verdict: "approved", checks: "failing" })),
    ).toBe(4);
  });

  test("ready-to-land is reachable without CI and before mergeability resolves", () => {
    // `none` (repo has no CI) and `unknown` (GitHub computes mergeability
    // lazily) are non-committal, not blocking. Requiring success/clean exactly
    // made bucket 3 unreachable on a CI-less repo, and made a PR flip out of it
    // between scans once mergeability resolved.
    const approved = { standing: "mine", verdict: "approved" } as const;
    expect(bucketOf(pr({ ...approved, checks: "none", merge: "clean" }))).toBe(3);
    expect(bucketOf(pr({ ...approved, checks: "success", merge: "unknown" }))).toBe(3);
    expect(bucketOf(pr({ ...approved, checks: "none", merge: "unknown" }))).toBe(3);
  });

  test("a pending check keeps an approved PR out of ready-to-land", () => {
    expect(
      bucketOf(pr({ standing: "mine", verdict: "approved", checks: "pending" })),
    ).toBe(5);
  });

  test("everything else is ambient", () => {
    expect(bucketOf(pr({ standing: "i-approved" }))).toBe(7);
    expect(bucketOf(pr({ standing: "i-commented" }))).toBe(7);
    expect(bucketOf(pr({ standing: "not-involved" }))).toBe(7);
  });

  test("empty buckets are omitted entirely", () => {
    const grouped = groupIntoBuckets([pr({ standing: "awaiting-me" })]);
    expect(grouped.map((b) => b.id)).toEqual([1]);
  });

  test("buckets come back in order", () => {
    const grouped = groupIntoBuckets([
      pr({ id: "a", standing: "not-involved" }),
      pr({ id: "b", standing: "awaiting-me" }),
      pr({ id: "c", standing: "mine", checks: "pending" }),
    ]);
    expect(grouped.map((b) => b.id)).toEqual([1, 5, 7]);
  });
});

describe("sorting", () => {
  test("bucket 1 puts the oldest ask first", () => {
    const old = pr({ id: "old", createdAt: "2026-01-01T00:00:00Z" });
    const recent = pr({ id: "new", createdAt: "2026-06-01T00:00:00Z" });
    expect([recent, old].sort((a, b) => compareWithin(1, a, b))[0]!.id).toBe("old");
  });

  test("bucket 1 puts a personal request above a CODEOWNERS one", () => {
    // Even though the CODEOWNERS request is older.
    const owners = pr({
      id: "owners",
      viaCodeOwners: true,
      createdAt: "2026-01-01T00:00:00Z",
    });
    const personal = pr({
      id: "personal",
      viaCodeOwners: false,
      createdAt: "2026-06-01T00:00:00Z",
    });
    expect([owners, personal].sort((a, b) => compareWithin(1, a, b))[0]!.id).toBe(
      "personal",
    );
  });

  test("bucket 2 puts the newest push first", () => {
    const stale = pr({ id: "stale", updatedAt: "2026-01-01T00:00:00Z" });
    const fresh = pr({ id: "fresh", updatedAt: "2026-06-01T00:00:00Z" });
    expect([stale, fresh].sort((a, b) => compareWithin(2, a, b))[0]!.id).toBe("fresh");
  });

  test("bucket 3 puts the longest-ready first", () => {
    const waiting = pr({ id: "waiting", updatedAt: "2026-01-01T00:00:00Z" });
    const recent = pr({ id: "recent", updatedAt: "2026-06-01T00:00:00Z" });
    expect([recent, waiting].sort((a, b) => compareWithin(3, a, b))[0]!.id).toBe(
      "waiting",
    );
  });

  test("drafts sort last even when they would otherwise lead", () => {
    const draft = pr({
      id: "draft",
      draft: true,
      createdAt: "2020-01-01T00:00:00Z",
    });
    const ready = pr({ id: "ready", createdAt: "2026-06-01T00:00:00Z" });
    expect([draft, ready].sort((a, b) => compareWithin(1, a, b))[0]!.id).toBe("ready");
  });

  test("ties break deterministically on repo then number", () => {
    const at = "2026-01-01T00:00:00Z";
    const items = [
      pr({ id: "b2", repo: "o/b", number: 2, createdAt: at, updatedAt: at }),
      pr({ id: "a9", repo: "o/a", number: 9, createdAt: at, updatedAt: at }),
      pr({ id: "b1", repo: "o/b", number: 1, createdAt: at, updatedAt: at }),
    ];
    const once = [...items].sort((a, b) => compareWithin(7, a, b)).map((p) => p.id);
    const twice = [...items].reverse().sort((a, b) => compareWithin(7, a, b)).map((p) => p.id);
    expect(once).toEqual(["a9", "b1", "b2"]);
    expect(twice).toEqual(once);
  });
});

describe("normalize", () => {
  test("carries stack position only when both halves are present", () => {
    expect(
      normalize(raw({ stack: { number: 7, size: 4 }, stackEntry: { position: 2 } }), VIEWER)
        .stack,
    ).toEqual({ number: 7, size: 4, position: 2 });
    expect(normalize(raw({ stack: { number: 7, size: 4 } }), VIEWER).stack).toBeNull();
    expect(normalize(raw(), VIEWER).stack).toBeNull();
  });

  test("counts opinionated reviews by others, excluding mine", () => {
    const p = normalize(
      raw({
        latestOpinionatedReviews: {
          nodes: [
            review(VIEWER, "APPROVED"),
            review("alice", "APPROVED"),
            review("bob", "CHANGES_REQUESTED"),
          ],
        },
      }),
      VIEWER,
    );
    expect(p.otherReviews).toBe(2);
  });

  test("survives a deleted author", () => {
    expect(normalize(raw({ author: null }), VIEWER).author).toBe("ghost");
  });
});

describe("flatten", () => {
  test("is newest-updated first with a deterministic tiebreak", () => {
    const at = "2026-01-01T00:00:00Z";
    const flat = flatten([
      pr({ id: "old", updatedAt: at, repo: "o/b", number: 1 }),
      pr({ id: "new", updatedAt: "2026-06-01T00:00:00Z" }),
      pr({ id: "old2", updatedAt: at, repo: "o/a", number: 1 }),
    ]);
    expect(flat.map((p) => p.id)).toEqual(["new", "old2", "old"]);
  });
});

describe("sanitize", () => {
  test("strips control characters that reach the terminal", () => {
    // A newline breaks the renderer's one-row-per-PR viewport maths and blanks
    // the dashboard; BEL and ESC reach the terminal raw.
    expect(sanitize("a\nb")).toBe("a b");
    expect(sanitize("a\u0007b")).toBe("a b");
    expect(sanitize("a\u001b]52;c;evil\u0007b")).not.toInclude("\u001b");
    expect(sanitize("a\tb")).toBe("a b");
  });

  test("strips bidi overrides used to spoof a repo name", () => {
    expect(sanitize("safe\u202Eoops")).toBe("safe oops");
    expect(sanitize("a\u200Bb")).toBe("a b");
  });

  test("leaves ordinary text alone, including emoji and CJK", () => {
    expect(sanitize("fix: don't break 🎉 日本語")).toBe("fix: don't break 🎉 日本語");
  });
});

describe("safeUrl", () => {
  test("accepts https only", () => {
    expect(safeUrl("https://github.com/o/r/pull/1")).toBe(
      "https://github.com/o/r/pull/1",
    );
    expect(safeUrl("http://github.com/o/r/pull/1")).toBeNull();
  });

  test("rejects schemes that would be handed to the system opener", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("file:///etc/passwd")).toBeNull();
    expect(safeUrl("x-custom://run")).toBeNull();
  });

  test("neutralises a URL carrying an escape sequence", () => {
    // Returning `parsed.href` rather than the input is the defence: URL
    // normalisation percent-encodes the ESC, so no raw byte can break out of
    // the OSC 8 hyperlink.
    const hostile = "https://ok.example/\u001b\\\u001b]52;c;cm0K\u001b\\";
    const cleaned = safeUrl(hostile);
    expect(cleaned).not.toBeNull();
    expect(cleaned).not.toInclude("\u001b");
    expect(cleaned).toInclude("%1B");
    // And because it is not byte-identical to the input, a cache entry holding
    // the raw form is rejected outright.
    expect(cleaned).not.toBe(hostile);
  });

  test("rejects non-strings and nonsense", () => {
    expect(safeUrl(null)).toBeNull();
    expect(safeUrl(42)).toBeNull();
    expect(safeUrl("not a url")).toBeNull();
  });
});

describe("normalize hardening", () => {
  test("sanitises every remote string it carries", () => {
    const p = normalize(
      raw({
        title: "drop\nthe\u0007dashboard",
        repository: { nameWithOwner: "o/r\u202Eevil" },
        author: { login: "a\nb" },
      }),
      VIEWER,
    );
    expect(p.title).toBe("drop the dashboard");
    expect(p.repo).not.toInclude("\u202E");
    expect(p.author).toBe("a b");
  });

  test("nulls a URL that is not https", () => {
    expect(normalize(raw({ url: "javascript:alert(1)" }), VIEWER).url).toBeNull();
    expect(normalize(raw({ url: "https://github.com/x" }), VIEWER).url).toBe(
      "https://github.com/x",
    );
  });
});

describe("isPullRequest", () => {
  const good = normalize(raw(), VIEWER);

  test("accepts what normalize produces", () => {
    expect(isPullRequest(good)).toBe(true);
    expect(isPullRequest({ ...good, url: null })).toBe(true);
  });

  test("rejects a record with a non-https url", () => {
    // The cache is writable by anything in $HOME and this url reaches `open`.
    expect(isPullRequest({ ...good, url: "javascript:alert(1)" })).toBe(false);
    expect(isPullRequest({ ...good, url: "file:///tmp/x" })).toBe(false);
  });

  test("rejects unknown enum values", () => {
    expect(isPullRequest({ ...good, verdict: "made-up" })).toBe(false);
    expect(isPullRequest({ ...good, standing: "made-up" })).toBe(false);
    expect(isPullRequest({ ...good, checks: "made-up" })).toBe(false);
    expect(isPullRequest({ ...good, merge: "made-up" })).toBe(false);
  });

  test("rejects a missing or misshapen field", () => {
    expect(isPullRequest({ ...good, id: undefined })).toBe(false);
    expect(isPullRequest({ ...good, number: "1" })).toBe(false);
    expect(isPullRequest({ ...good, stack: { number: 1 } })).toBe(false);
    expect(isPullRequest(null)).toBe(false);
    expect(isPullRequest("nope")).toBe(false);
  });
});
