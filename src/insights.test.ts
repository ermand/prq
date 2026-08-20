import { describe, expect, test } from "bun:test";
import type { CensusPr, CensusReview, Person, PrState, ReviewAct } from "./census";
import type { Provider } from "./domain";
import { personInsight, repoInsight, repoTotals } from "./insights";

/**
 * Every timestamp here is written out. `now` is an argument to both entry
 * points precisely so no test needs a clock or a sleep, and every window
 * (staleness, month spans, latency) is checkable by reading the literals.
 */
const NOW = new Date("2026-06-15T00:00:00Z");

function pr(over: Partial<CensusPr> = {}): CensusPr {
  return {
    provider: "github",
    repo: "o/r",
    number: 1,
    state: "open",
    draft: false,
    title: "A change",
    url: "https://github.com/o/r/pull/1",
    author: "someone",
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-02T00:00:00Z",
    mergedAt: null,
    closedAt: null,
    additions: 10,
    deletions: 5,
    files: 2,
    mergedBy: "",
    ...over,
  };
}

/** A merged PR whose lifetime is exactly `hours`. */
function merged(number: number, hours: number, over: Partial<CensusPr> = {}): CensusPr {
  const created = Date.parse("2026-01-01T00:00:00Z");
  return pr({
    number,
    state: "merged",
    createdAt: new Date(created).toISOString(),
    mergedAt: new Date(created + hours * 3_600_000).toISOString(),
    mergedBy: "maintainer",
    ...over,
  });
}

function review(over: Partial<CensusReview> = {}): CensusReview {
  return {
    provider: "github",
    repo: "o/r",
    number: 1,
    reviewer: "reviewer",
    act: "approved",
    at: "2026-06-02T00:00:00Z",
    ...over,
  };
}

function person(aliases: [Provider, string][], label = "Ermand"): Person {
  return {
    id: "ermand",
    label,
    aliases: aliases.map(([provider, username]) => ({ provider, username })),
    // Insights are blind to this on purpose: an inactive person's work still
    // counts everywhere. The mark changes what is fetched and shown, never what
    // is computed.
    active: true,
  };
}

const repo = (prs: CensusPr[], reviews: CensusReview[] = []) =>
  repoInsight(prs, reviews, "exact", NOW);

describe("empty input", () => {
  test("yields nulls rather than zeros, and does not throw", () => {
    const insight = repo([]);

    expect(insight.counts).toEqual({ open: 0, merged: 0, closed: 0, total: 0 });
    expect(insight.medianHoursToMerge).toBeNull();
    expect(insight.p90HoursToMerge).toBeNull();
    expect(insight.mergeRate).toBeNull();
    expect(insight.reviewCoverage).toBeNull();
    expect(insight.oldestOpenDays).toBeNull();
    expect(insight.authors).toEqual([]);
    expect(insight.reviewers).toEqual([]);
    expect(insight.throughput).toEqual([]);
    expect(insight.staleOpen).toEqual([]);
  });

  test("a person with no rows reports nulls, not a zeroed profile", () => {
    const insight = personInsight(person([["github", "ermand"]]), [], [], "exact", NOW);

    expect(insight.medianHoursToMerge).toBeNull();
    expect(insight.mergeRate).toBeNull();
    expect(insight.medianReviewLatencyHours).toBeNull();
    expect(insight.firstSeen).toBeNull();
    expect(insight.lastSeen).toBeNull();
    expect(insight.activity).toEqual([]);
    expect(insight.reviewsGiven.total).toBe(0);
  });
});

describe("time to merge", () => {
  test("the median holds while p90 exposes the tail", () => {
    // Nine quick merges and one that sat for a thousand hours. A mean would be
    // dragged to ~103h and describe none of these pull requests.
    const prs = [
      ...Array.from({ length: 9 }, (_, i) => merged(i + 1, 2)),
      merged(10, 1000),
    ];

    const insight = repo(prs);

    expect(insight.medianHoursToMerge).toBe(2);
    // The tail is visible instead of averaged away: 101.8h, not the 2h median
    // and not a mean that describes no pull request in the set.
    expect(insight.p90HoursToMerge).toBe(101.8);
  });

  test("the median is the middle pair on an even count", () => {
    const insight = repo([merged(1, 1), merged(2, 2), merged(3, 4), merged(4, 9)]);

    expect(insight.medianHoursToMerge).toBe(3);
  });

  test("size medians resist a single huge refactor", () => {
    const prs = [
      merged(1, 1, { additions: 10, deletions: 1, files: 1 }),
      merged(2, 1, { additions: 12, deletions: 2, files: 1 }),
      merged(3, 1, { additions: 4000, deletions: 900, files: 90 }),
    ];

    const insight = repo(prs);

    expect(insight.medianAdditions).toBe(12);
    expect(insight.medianDeletions).toBe(2);
    expect(insight.medianFiles).toBe(1);
  });
});

describe("merge rate", () => {
  test("open pull requests are undecided and stay out of the denominator", () => {
    const prs = [
      merged(1, 5),
      merged(2, 5),
      pr({ number: 3, state: "closed", closedAt: "2026-02-01T00:00:00Z" }),
      pr({ number: 4, state: "open" }),
      pr({ number: 5, state: "open" }),
      pr({ number: 6, state: "open" }),
    ];

    const insight = repo(prs);

    // 2 merged of 3 decided — not 2 of 6, which would call this repo failing.
    expect(insight.mergeRate).toBeCloseTo(2 / 3, 10);
    expect(insight.counts).toEqual({ open: 3, merged: 2, closed: 1, total: 6 });
  });

  test("a repo of nothing but open pull requests cannot report a rate", () => {
    expect(repo([pr({ number: 1 }), pr({ number: 2 })]).mergeRate).toBeNull();
  });
});

describe("review coverage", () => {
  test("self-review is not coverage", () => {
    const prs = [merged(1, 5, { author: "ermand" }), merged(2, 5, { author: "ermand" })];
    const reviews = [
      review({ number: 1, reviewer: "ermand" }),
      review({ number: 2, reviewer: "other" }),
    ];

    const insight = repo(prs, reviews);

    expect(insight.reviewCoverage).toBe(0.5);
    expect(insight.unreviewedMerges).toBe(1);
  });

  test("a hidden reviewer is not credited as independent review", () => {
    const insight = repo([merged(1, 5, { author: "ermand" })], [review({ reviewer: "" })]);

    expect(insight.reviewCoverage).toBe(0);
    expect(insight.unreviewedMerges).toBe(1);
  });

  test("coverage is withheld when nothing has merged", () => {
    const insight = repo([pr({ number: 1 })], [review({ number: 1, reviewer: "other" })]);

    expect(insight.reviewCoverage).toBeNull();
    expect(insight.unreviewedMerges).toBe(0);
  });

  test("any act by another human counts, including a dismissal", () => {
    const insight = repo(
      [merged(1, 5, { author: "ermand" })],
      [review({ reviewer: "other", act: "dismissed" })],
    );

    expect(insight.reviewCoverage).toBe(1);
  });
});

describe("self-merge", () => {
  test("author pressing their own merge button counts", () => {
    const insight = repo([merged(1, 5, { author: "ermand", mergedBy: "ermand" })]);

    expect(insight.selfMerged).toBe(1);
  });

  test("two hidden accounts are not evidence of a self-merge", () => {
    const insight = repo([merged(1, 5, { author: "", mergedBy: "" })]);

    expect(insight.selfMerged).toBe(0);
  });

  test("a different merger does not count", () => {
    const insight = repo([merged(1, 5, { author: "ermand", mergedBy: "maintainer" })]);

    expect(insight.selfMerged).toBe(0);
  });
});

describe("throughput", () => {
  test("a quiet month is present and empty, not compressed away", () => {
    const prs = [
      pr({
        number: 1,
        state: "merged",
        createdAt: "2026-01-10T00:00:00Z",
        mergedAt: "2026-01-11T00:00:00Z",
      }),
      // Nothing at all in February.
      pr({
        number: 2,
        state: "merged",
        createdAt: "2026-03-05T00:00:00Z",
        mergedAt: "2026-03-06T00:00:00Z",
      }),
    ];

    const months = repoInsight(prs, [], "exact", new Date("2026-03-20T00:00:00Z")).throughput;

    expect(months.map((m) => m.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(months[1]).toEqual({ month: "2026-02", opened: 0, merged: 0 });
    expect(months[0]).toEqual({ month: "2026-01", opened: 1, merged: 1 });
  });

  test("the series runs to now even when activity stopped months ago", () => {
    const prs = [pr({ number: 1, createdAt: "2026-01-10T00:00:00Z" })];

    const months = repoInsight(prs, [], "exact", new Date("2026-04-02T00:00:00Z")).throughput;

    expect(months.map((m) => m.month)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
  });

  test("months are bucketed in UTC, not local time", () => {
    const prs = [pr({ number: 1, createdAt: "2026-02-01T00:30:00Z" })];

    const months = repoInsight(prs, [], "exact", new Date("2026-02-10T00:00:00Z")).throughput;

    expect(months).toEqual([{ month: "2026-02", opened: 1, merged: 0 }]);
  });
});

describe("stale open", () => {
  test("caps at ten and lists the newest first", () => {
    // Fourteen open pull requests, each a day older than the last, all past 30
    // days. The newest ten are the ones still worth a nudge.
    const prs = Array.from({ length: 14 }, (_, i) =>
      pr({
        number: i + 1,
        createdAt: new Date(Date.parse("2026-05-01T00:00:00Z") - i * 86_400_000).toISOString(),
      }),
    );

    const insight = repo(prs);

    expect(insight.staleOpen).toHaveLength(10);
    expect(insight.staleOpen.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(insight.staleOpen[0]!.days).toBeLessThan(insight.staleOpen[9]!.days);
  });

  test("a pull request inside the window is not stale, but still counts as oldest", () => {
    const prs = [
      pr({ number: 1, createdAt: "2026-06-01T00:00:00Z" }),
      pr({ number: 2, createdAt: "2026-04-01T00:00:00Z" }),
    ];

    const insight = repo(prs);

    expect(insight.staleOpen.map((s) => s.number)).toEqual([2]);
    expect(insight.staleOpen[0]!.days).toBe(75);
    expect(insight.oldestOpenDays).toBe(75);
  });

  test("merged and closed rows are never stale, however old", () => {
    const insight = repo([merged(1, 5), pr({ number: 2, state: "closed" })]);

    expect(insight.staleOpen).toEqual([]);
    expect(insight.oldestOpenDays).toBeNull();
  });

  test("drafts are counted apart from the rest of the open cohort", () => {
    const insight = repo([pr({ number: 1, draft: true }), pr({ number: 2 })]);

    expect(insight.draftOpen).toBe(1);
  });
});

describe("leaderboards", () => {
  test("equal counts break on username, so renders never reorder", () => {
    const prs = [
      pr({ number: 1, author: "zoe" }),
      pr({ number: 2, author: "adam" }),
      pr({ number: 3, author: "mia" }),
    ];

    const forward = repo(prs).authors.map((a) => a.username);
    const backward = repo([...prs].reverse()).authors.map((a) => a.username);

    expect(forward).toEqual(["adam", "mia", "zoe"]);
    expect(backward).toEqual(forward);
  });

  test("the same login on two forges stays two separate rows", () => {
    const prs = [
      pr({ number: 1, provider: "github", author: "ermand" }),
      pr({ number: 2, provider: "gitlab", repo: "g/p", author: "ermand", url: null }),
    ];

    const authors = repo(prs).authors;

    expect(authors).toHaveLength(2);
    expect(authors.map((a) => a.provider)).toEqual(["github", "gitlab"]);
  });

  test("a hidden author does not become a phantom top contributor", () => {
    const prs = [pr({ number: 1, author: "" }), pr({ number: 2, author: "" }), pr({ number: 3, author: "real" })];

    const insight = repo(prs);

    expect(insight.authors.map((a) => a.username)).toEqual(["real"]);
    expect(insight.counts.total).toBe(3);
  });

  test("a dismissal counts in the total but in no opinion bucket", () => {
    const reviews = [
      review({ reviewer: "r", act: "dismissed" }),
      review({ reviewer: "r", act: "approved" }),
    ];

    const stat = repo([pr({ number: 1 })], reviews).reviewers[0]!;

    expect(stat).toMatchObject({ approved: 1, changesRequested: 0, commented: 0, total: 2 });
  });

  test("reviewers with equal totals break on username", () => {
    const reviews = [
      review({ number: 1, reviewer: "zoe" }),
      review({ number: 2, reviewer: "adam" }),
    ];

    const order = repo([pr({ number: 1 }), pr({ number: 2 })], reviews).reviewers;

    expect(order.map((r) => r.username)).toEqual(["adam", "zoe"]);
  });
});

describe("review precision", () => {
  test("approximate forces the latency null even with review rows present", () => {
    const prs = [pr({ number: 1, author: "other", provider: "gitlab", repo: "g/p", url: null })];
    // GitLab acts do arrive; they simply carry no timestamp to subtract.
    const reviews = [
      { provider: "gitlab" as Provider, repo: "g/p", number: 1, reviewer: "ermandduro", act: "approved" as ReviewAct, at: null },
    ];

    const insight = personInsight(
      person([["gitlab", "ermandduro"]]),
      prs,
      reviews,
      "approximate",
      NOW,
    );

    expect(insight.reviewsGiven.total).toBe(1);
    expect(insight.medianReviewLatencyHours).toBeNull();
    expect(insight.reviewPrecision).toBe("approximate");
  });

  test("approximate stays null even when a timestamp happens to be present", () => {
    // A mixed batch must not leak a latency: the cohort is unattributable in
    // time, so a median over the few timestamped rows would be a lie.
    const prs = [pr({ number: 1, author: "other", createdAt: "2026-06-01T00:00:00Z" })];
    const reviews = [review({ number: 1, reviewer: "ermand", at: "2026-06-01T06:00:00Z" })];

    const insight = personInsight(
      person([["github", "ermand"]]),
      prs,
      reviews,
      "approximate",
      NOW,
    );

    expect(insight.medianReviewLatencyHours).toBeNull();
  });

  test("exact precision measures latency from creation to the act", () => {
    const prs = [
      pr({ number: 1, author: "other", createdAt: "2026-06-01T00:00:00Z" }),
      pr({ number: 2, author: "other", createdAt: "2026-06-01T00:00:00Z" }),
    ];
    const reviews = [
      review({ number: 1, reviewer: "ermand", at: "2026-06-01T02:00:00Z" }),
      review({ number: 2, reviewer: "ermand", at: "2026-06-01T10:00:00Z" }),
    ];

    const insight = personInsight(person([["github", "ermand"]]), prs, reviews, "exact", NOW);

    expect(insight.medianReviewLatencyHours).toBe(6);
  });
});

describe("person across forges", () => {
  const ermand = person([
    ["github", "ermand"],
    ["gitlab", "ermandduro"],
  ]);

  function twoForges(): CensusPr[] {
    return [
      pr({
        provider: "github",
        repo: "o/r",
        number: 1,
        author: "ermand",
        state: "merged",
        createdAt: "2026-04-01T00:00:00Z",
        mergedAt: "2026-04-02T00:00:00Z",
        updatedAt: "2026-04-02T00:00:00Z",
        additions: 100,
        deletions: 10,
        files: 3,
      }),
      pr({
        provider: "gitlab",
        repo: "g/p",
        url: null,
        number: 7,
        author: "ermandduro",
        state: "closed",
        createdAt: "2026-05-01T00:00:00Z",
        closedAt: "2026-05-02T00:00:00Z",
        updatedAt: "2026-05-02T00:00:00Z",
        additions: 40,
        deletions: 4,
        files: 1,
      }),
      // A different human who happens to share the GitHub login on GitLab.
      pr({
        provider: "gitlab",
        repo: "g/p",
        url: null,
        number: 8,
        author: "ermand",
        state: "merged",
        createdAt: "2026-05-10T00:00:00Z",
        mergedAt: "2026-05-11T00:00:00Z",
        updatedAt: "2026-05-11T00:00:00Z",
        additions: 999,
        deletions: 999,
        files: 99,
      }),
    ];
  }

  test("both aliases aggregate, and the same-named stranger is not absorbed", () => {
    const insight = personInsight(ermand, twoForges(), [], "exact", NOW);

    expect(insight.counts).toEqual({ open: 0, merged: 1, closed: 1, total: 2 });
    // 999 additions belong to the GitLab `ermand`, who is somebody else.
    expect(insight.additions).toBe(140);
    expect(insight.deletions).toBe(14);
    expect(insight.files).toBe(4);
    expect(insight.repos.map((r) => `${r.provider}:${r.repo}`)).toEqual([
      "github:o/r",
      "gitlab:g/p",
    ]);
    expect(insight.mergeRate).toBe(0.5);
  });

  test("the stranger's own profile holds only their row", () => {
    const stranger = person([["gitlab", "ermand"]], "GitLab ermand");

    const insight = personInsight(stranger, twoForges(), [], "exact", NOW);

    expect(insight.counts.total).toBe(1);
    expect(insight.additions).toBe(999);
  });

  test("matching is by identity, so a bare-login match on the wrong forge is refused", () => {
    const githubOnly = person([["github", "ermand"]]);

    const insight = personInsight(githubOnly, twoForges(), [], "exact", NOW);

    expect(insight.counts.total).toBe(1);
    expect(insight.repos).toHaveLength(1);
    expect(insight.repos[0]!.provider).toBe("github");
  });

  test("given and received are split, and self-review lands only in given", () => {
    const prs = twoForges();
    const reviews = [
      // On her own GitHub PR, by herself.
      review({ number: 1, reviewer: "ermand", at: "2026-04-01T06:00:00Z" }),
      // On her own GitHub PR, by a colleague.
      review({ number: 1, reviewer: "colleague", act: "changes-requested", at: "2026-04-01T08:00:00Z" }),
      // By her GitLab alias, on the stranger's merge request.
      {
        provider: "gitlab" as Provider,
        repo: "g/p",
        number: 8,
        reviewer: "ermandduro",
        act: "commented" as ReviewAct,
        at: "2026-05-10T12:00:00Z",
      },
      // On a pull request she did not author — neither given nor received.
      review({ number: 99, reviewer: "colleague", at: "2026-04-05T00:00:00Z" }),
    ];

    const insight = personInsight(ermand, prs, reviews, "exact", NOW);

    expect(insight.reviewsGiven).toMatchObject({ approved: 1, commented: 1, total: 2 });
    expect(insight.reviewsReceived).toMatchObject({ changesRequested: 1, total: 1 });
    // The stat carries the primary alias; the counts span both forges.
    expect(insight.reviewsGiven.provider).toBe("github");
    expect(insight.reviewsGiven.username).toBe("ermand");
  });

  test("activity spans complete months and includes review acts", () => {
    const prs = twoForges();
    const reviews = [review({ number: 1, reviewer: "ermand", at: "2026-06-01T00:00:00Z" })];

    const insight = personInsight(ermand, prs, reviews, "exact", NOW);
    const months = insight.activity.map((a) => a.month);

    expect(months).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(insight.activity[0]).toEqual({
      month: "2026-04",
      opened: 1,
      merged: 1,
      reviews: 0,
    });
    expect(insight.activity[2]).toEqual({
      month: "2026-06",
      opened: 0,
      merged: 0,
      reviews: 1,
    });
    expect(insight.firstSeen).toBe("2026-04-01T00:00:00Z");
    expect(insight.lastSeen).toBe("2026-06-01T00:00:00Z");
  });

  test("a review with no timestamp cannot be placed in a month and is not invented", () => {
    const prs = [pr({ number: 1, author: "other", createdAt: "2026-06-01T00:00:00Z" })];
    const reviews = [review({ number: 1, reviewer: "ermand", at: null })];

    const insight = personInsight(person([["github", "ermand"]]), prs, reviews, "exact", NOW);

    expect(insight.reviewsGiven.total).toBe(1);
    expect(insight.activity).toEqual([]);
    expect(insight.medianReviewLatencyHours).toBeNull();
  });

  test("a self-merge is detected through whichever alias pressed the button", () => {
    const prs = [
      pr({
        provider: "gitlab",
        repo: "g/p",
        url: null,
        number: 7,
        author: "ermandduro",
        mergedBy: "ermandduro",
        state: "merged",
        createdAt: "2026-05-01T00:00:00Z",
        mergedAt: "2026-05-02T00:00:00Z",
      }),
    ];

    expect(personInsight(ermand, prs, [], "exact", NOW).selfMerged).toBe(1);
  });

  test("repo rows break ties on repo path", () => {
    const prs: CensusPr[] = ["b/two", "a/one"].map((path, i) =>
      pr({ repo: path, number: i + 1, author: "ermand" }),
    );

    const insight = personInsight(ermand, prs, [], "exact", NOW);

    expect(insight.repos.map((r) => r.repo)).toEqual(["a/one", "b/two"]);
  });
});

describe("repoTotals", () => {
  test("keys on provider and repo path", () => {
    const states: PrState[] = ["open", "merged", "merged", "closed"];
    const prs = states.map((state, i) => pr({ number: i + 1, state }));
    prs.push(pr({ provider: "gitlab", repo: "g/p", url: null, number: 9, state: "open" }));

    const totals = repoTotals(prs);

    expect([...totals.keys()].sort()).toEqual(["github:o/r", "gitlab:g/p"]);
    expect(totals.get("github:o/r")).toEqual({ open: 1, merged: 2, closed: 1, total: 4 });
    expect(totals.get("gitlab:g/p")).toEqual({ open: 1, merged: 0, closed: 0, total: 1 });
  });

  test("a GitHub repo and a GitLab project sharing a path stay apart", () => {
    const totals = repoTotals([
      pr({ number: 1, state: "merged" }),
      pr({ provider: "gitlab", number: 2, state: "open", url: null }),
    ]);

    expect(totals.size).toBe(2);
  });

  test("no rows, no keys", () => {
    expect(repoTotals([]).size).toBe(0);
  });
});

describe("repo identity", () => {
  test("provider and repo come from the rows", () => {
    const insight = repo([pr({ provider: "gitlab", repo: "g/p", url: null })]);

    expect(insight.provider).toBe("gitlab");
    expect(insight.repo).toBe("g/p");
  });

  test("precision is passed through untouched", () => {
    expect(repoInsight([], [], "approximate", NOW).reviewPrecision).toBe("approximate");
  });
});
