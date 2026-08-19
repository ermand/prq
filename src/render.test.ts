import { describe, expect, test } from "bun:test";
import { normalize, type PullRequest, type RawPullRequest } from "./domain";
import {
  buildRows,
  formatRow,
  matchesFilter,
  relativeAge,
  selectableIndices,
  statusLine,
  visiblePrs,
  type ViewState,
} from "./render";

function pr(over: Partial<PullRequest> = {}): PullRequest {
  const base = normalize(
    {
      id: "PR_1",
      number: 1,
      title: "A change",
      url: "u",
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

function state(over: Partial<ViewState> = {}): ViewState {
  return {
    prs: [],
    grouped: true,
    filter: "",
    stackFocus: null,
    changedOnly: false,
    changedIds: new Set(),
    ...over,
  };
}

const extras = (over: Partial<Parameters<typeof statusLine>[2]> = {}) => ({
  viewer: "ermand",
  repos: 3,
  age: "just now",
  partial: false,
  changeCount: 0,
  goneCount: 0,
  baselineReset: false,
  ...over,
});

describe("matchesFilter", () => {
  test("an empty filter matches everything", () => {
    expect(matchesFilter(pr(), "")).toBe(true);
    expect(matchesFilter(pr(), "   ")).toBe(true);
  });

  test("matches title, repo, author and number, case-insensitively", () => {
    const p = pr({ title: "Fix the Thing", repo: "org/widget", author: "Bob", number: 42 });
    expect(matchesFilter(p, "thing")).toBe(true);
    expect(matchesFilter(p, "WIDGET")).toBe(true);
    expect(matchesFilter(p, "bob")).toBe(true);
    expect(matchesFilter(p, "42")).toBe(true);
    expect(matchesFilter(p, "absent")).toBe(false);
  });
});

describe("visiblePrs", () => {
  test("stack focus keeps only that stack", () => {
    const inStack = pr({ id: "a", stacks: [{ id: "7", size: 3, position: 1, precision: "exact" }] });
    const other = pr({ id: "b", stacks: [{ id: "9", size: 2, position: 1, precision: "exact" }] });
    const loose = pr({ id: "c" });
    const visible = visiblePrs(
      state({ prs: [inStack, other, loose], stackFocus: "7" }),
    );
    expect(visible.map((p) => p.id)).toEqual(["a"]);
  });

  test("filter and stack focus both apply", () => {
    const match = pr({ id: "a", title: "alpha", stacks: [{ id: "7", size: 2, position: 1, precision: "exact" }] });
    const wrongTitle = pr({ id: "b", title: "beta", stacks: [{ id: "7", size: 2, position: 2, precision: "exact" }] });
    expect(
      visiblePrs(state({ prs: [match, wrongTitle], stackFocus: "7", filter: "alpha" })).map(
        (p) => p.id,
      ),
    ).toEqual(["a"]);
  });
});

describe("buildRows", () => {
  test("grouped mode emits a header before each bucket's items", () => {
    const rows = buildRows(
      state({ prs: [pr({ id: "a", standing: "awaiting-me" })] }),
    );
    expect(rows[0]).toEqual({ kind: "bucket", label: "Awaiting me", count: 1 });
    expect(rows[1]?.kind).toBe("pr");
  });

  test("flat mode emits no headers", () => {
    const rows = buildRows(
      state({
        grouped: false,
        prs: [pr({ id: "a", standing: "awaiting-me" }), pr({ id: "b", standing: "mine" })],
      }),
    );
    expect(rows.every((r) => r.kind === "pr")).toBe(true);
    expect(rows).toHaveLength(2);
  });

  test("an empty result produces no rows at all", () => {
    expect(buildRows(state())).toEqual([]);
  });
});

describe("selectableIndices", () => {
  test("skips bucket headers so the cursor never lands on one", () => {
    const rows = buildRows(
      state({
        prs: [pr({ id: "a", standing: "awaiting-me" }), pr({ id: "b", standing: "mine" })],
      }),
    );
    for (const i of selectableIndices(rows)) expect(rows[i]!.kind).toBe("pr");
    expect(selectableIndices(rows)).toHaveLength(2);
  });
});

describe("relativeAge", () => {
  const now = new Date("2026-01-10T12:00:00Z");
  test("scales from minutes to years", () => {
    expect(relativeAge("2026-01-10T11:30:00Z", now)).toBe("30m");
    expect(relativeAge("2026-01-10T06:00:00Z", now)).toBe("6h");
    expect(relativeAge("2026-01-01T12:00:00Z", now)).toBe("9d");
    expect(relativeAge("2023-01-10T12:00:00Z", now)).toBe("3y");
  });

  test("clamps a future timestamp to zero rather than going negative", () => {
    expect(relativeAge("2026-06-01T00:00:00Z", now)).toBe("0m");
  });
});

describe("formatRow", () => {
  const now = new Date("2026-01-01T01:00:00Z");

  test("drops the owner from the ref", () => {
    expect(formatRow(pr({ repo: "org/widget", number: 9 }), 120, now).ref).toBe(
      "widget#9",
    );
  });

  test("truncates the title, never the state", () => {
    const long = pr({ title: "x".repeat(200), author: "alice" });
    const row = formatRow(long, 80, now);
    expect(row.title.length).toBeLessThan(200);
    expect(row.title).toEndWith("…");
    expect(row.badge).toBe("NEW ");
    expect(row.meta).toInclude("alice");
  });

  test("keeps a short title intact", () => {
    expect(formatRow(pr({ title: "Short" }), 120, now).title).toBe("Short");
  });

  test("never truncates below a readable floor", () => {
    // A very narrow terminal must not produce an empty or negative-width title.
    expect(formatRow(pr({ title: "x".repeat(50) }), 10, now).title.length).toBeGreaterThan(1);
  });

  test("shows stack position and conflict and CI state", () => {
    const row = formatRow(
      pr({ stacks: [{ id: "5", size: 4, position: 2, precision: "exact" }], merge: "conflicted", checks: "failing" }),
      120,
      now,
    );
    expect(row.meta).toInclude("2/4");
    expect(row.meta).toInclude("x");
    expect(row.meta).toInclude("!");
  });

  test("omits the stack marker entirely when there is no stack", () => {
    expect(formatRow(pr(), 120, now).meta).not.toInclude("/");
  });
});

describe("statusLine", () => {
  test("reports viewer, counts and age", () => {
    expect(statusLine(state(), 5, extras())).toBe("ermand · 5 PRs · 3 repos · just now");
  });

  test("says so when nothing has ever been synced", () => {
    expect(statusLine(state(), 0, extras({ viewer: "" }))).toStartWith("not synced");
  });

  test("singularises one PR and one repo", () => {
    expect(statusLine(state(), 1, extras({ repos: 1 }))).toInclude("1 PR · 1 repo ·");
  });

  test("announces an incomplete scan and that it was not committed", () => {
    // A half-union must never read as whole, and must never become a baseline.
    const line = statusLine(state(), 5, extras({ partial: true }));
    expect(line).toInclude("INCOMPLETE");
    expect(line).toInclude("not committed");
  });

  test("reports how many PRs changed", () => {
    expect(statusLine(state(), 5, extras({ changeCount: 3 }))).toInclude("3 changed");
  });

  test("a first sync says baseline set, not zero changed", () => {
    // "0 changed" would imply nothing moved; the truth is nothing was comparable.
    const line = statusLine(state(), 5, extras({ changeCount: 0, baselineReset: true }));
    expect(line).toInclude("baseline set");
    expect(line).not.toInclude("0 changed");
  });

  test("a real change count wins over the baseline note", () => {
    const line = statusLine(state(), 5, extras({ changeCount: 2, baselineReset: true }));
    expect(line).toInclude("2 changed");
    expect(line).not.toInclude("baseline set");
  });

  test("shows active modes", () => {
    const line = statusLine(
      state({ grouped: false, filter: "auth", stackFocus: "12", changedOnly: true }),
      5,
      extras(),
    );
    expect(line).toInclude("flat");
    expect(line).toInclude("changed only");
    expect(line).toInclude("one stack");
    expect(line).toInclude("/auth");
  });
});

describe("changedOnly", () => {
  test("keeps only PRs that moved", () => {
    const moved = pr({ id: "moved" });
    const still = pr({ id: "still" });
    const visible = visiblePrs(
      state({ prs: [moved, still], changedOnly: true, changedIds: new Set(["moved"]) }),
    );
    expect(visible.map((p) => p.id)).toEqual(["moved"]);
  });

  test("is inert when off", () => {
    const prs = [pr({ id: "a" }), pr({ id: "b", number: 2 })];
    expect(visiblePrs(state({ prs, changedIds: new Set(["a"]) }))).toHaveLength(2);
  });
});

describe("the ref cannot alias across providers", () => {
  const now = new Date("2026-01-01T01:00:00Z");

  test("a nested GitLab path shows its project, not a middle segment", () => {
    // `split("/")[1]` rendered group/subgroup/project as `subgroup#42`.
    const row = formatRow(
      pr({ provider: "gitlab", repo: "group/subgroup/project", number: 42 }),
      120,
      now,
    );
    expect(row.ref).toBe("gl:project#42");
  });

  test("a GitLab project cannot impersonate a GitHub repo", () => {
    // `evil/facebook/react` rendered as `facebook#42`, visually identical to the
    // GitHub repo while its link pointed at gitlab.com.
    const spoof = formatRow(
      pr({ provider: "gitlab", repo: "evil/facebook/react", number: 42 }),
      120,
      now,
    );
    const real = formatRow(
      pr({ provider: "github", repo: "facebook/react", number: 42 }),
      120,
      now,
    );
    expect(spoof.ref).not.toBe(real.ref);
    expect(real.ref).toBe("react#42");
  });
});
