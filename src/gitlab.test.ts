import { afterEach, describe, expect, test } from "bun:test";
import {
  needsRefresh,
  concernsViewer,
  gitlab,
  gitlabCensus,
  normalizeMergeRequest,
  stacksOf,
  staleBlockOf,
  standingOf,
  toChecksFromPipeline,
  toMergeStateFromStatus,
  verdictOf,
} from "./gitlab";
import { MAX_PAGES } from "./census";

const realFetch = globalThis.fetch;
const realSpawn = Bun.spawn;
afterEach(() => {
  globalThis.fetch = realFetch;
  Bun.spawn = realSpawn;
  delete process.env.GITLAB_TOKEN;
});

const VIEWER = "ermandduro";

/** Shape mirrors the live GraphQL response; `mr` is the internal Raw type. */
function mr(over: Record<string, unknown> = {}) {
  return {
    id: "gid://gitlab/MergeRequest/1",
    iid: "326",
    title: "feat: something",
    webUrl: "https://gitlab.com/g/s/p/-/merge_requests/326",
    draft: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    diffHeadSha: "a".repeat(40),
    targetBranch: "main",
    conflicts: false,
    mergeStatusEnum: "CAN_BE_MERGED",
    detailedMergeStatus: "MERGEABLE",
    approvalsRequired: 0,
    author: { username: "someone" },
    project: { fullPath: "g/s/p" },
    headPipeline: { status: "SUCCESS" },
    approvedBy: { nodes: [] },
    changeRequesters: { nodes: [] },
    reviewers: { nodes: [] },
    assignees: { nodes: [] },
    commenters: { nodes: [] },
    participants: { nodes: [] },
    stack: [],
    mergeRequestDiffs: { nodes: [{ createdAt: "2026-01-02T00:00:00Z" }] },
    ...over,
  } as Parameters<typeof normalizeMergeRequest>[0];
}

const reviewer = (username: string, reviewState: string, updatedAt: string | null = null) => ({
  username,
  mergeRequestInteraction: { reviewState, reviewed: true, approved: false, updatedAt },
});

describe("pipeline status", () => {
  test("maps the real enum", () => {
    expect(toChecksFromPipeline("SUCCESS")).toBe("success");
    expect(toChecksFromPipeline("FAILED")).toBe("failing");
    for (const running of ["CREATED", "PREPARING", "PENDING", "RUNNING", "SCHEDULED"]) {
      expect(toChecksFromPipeline(running)).toBe("pending");
    }
  });

  test("a cancelled or skipped pipeline is not a failure", () => {
    // Nothing is going to happen, which is what `none` already means.
    for (const inert of ["CANCELED", "CANCELING", "SKIPPED", "MANUAL"]) {
      expect(toChecksFromPipeline(inert)).toBe("none");
    }
  });

  test("an absent pipeline is none, not failing", () => {
    // `headPipeline` was observed null while a pipeline existed, and is also
    // permission-gated, so absence must not read as broken.
    expect(toChecksFromPipeline(null)).toBe("none");
    expect(toChecksFromPipeline(undefined)).toBe("none");
  });
});

describe("merge state", () => {
  test("UNCHECKED and CHECKING are unknown, not clean", () => {
    // Observed on 3 of the driver's 8 real MRs, so not first-sight-only.
    expect(toMergeStateFromStatus("UNCHECKED", false, "UNCHECKED")).toBe("unknown");
    expect(toMergeStateFromStatus("CHECKING", false, "CHECKING")).toBe("unknown");
  });

  test("the detailed status wins over conflicts when they disagree", () => {
    // `conflicts` is documented as derived and was caught live reporting false
    // while detailedMergeStatus said CONFLICT.
    expect(toMergeStateFromStatus("CANNOT_BE_MERGED", false, "CONFLICT")).toBe("conflicted");
    expect(toMergeStateFromStatus("CAN_BE_MERGED", true, "MERGEABLE")).toBe("conflicted");
  });

  test("mergeable is clean", () => {
    expect(toMergeStateFromStatus("CAN_BE_MERGED", false, "MERGEABLE")).toBe("clean");
  });

  test("a named non-conflict blocker is not a content conflict", () => {
    // Those facts have their own columns — the checks glyph, the verdict, the draft
    // marker. Calling them conflicts double-reports under the wrong name.
    expect(toMergeStateFromStatus("CANNOT_BE_MERGED", false, "CI_MUST_PASS")).toBe("clean");
    expect(toMergeStateFromStatus("CANNOT_BE_MERGED", false, "NOT_APPROVED")).toBe("clean");
    expect(toMergeStateFromStatus("CANNOT_BE_MERGED", null, "DRAFT_STATUS")).toBe("clean");
  });

  test("an unexplained CANNOT_BE_MERGED is trusted as a conflict", () => {
    // `conflicts` was caught live reporting false against a CONFLICT detailed
    // status, so when nothing more specific is offered this is the last signal.
    expect(toMergeStateFromStatus("CANNOT_BE_MERGED", false, null)).toBe("conflicted");
  });

  test("a rebase requirement is a conflict by another name", () => {
    expect(toMergeStateFromStatus("CAN_BE_MERGED", false, "NEED_REBASE")).toBe("conflicted");
  });

  test("an invalidated merge check is unknown, not clean", () => {
    // RECHECK means "invalidated, awaiting recomputation". Calling it clean makes
    // GitLab's invalidation read as "your conflict was resolved" and fires a
    // spurious merge change each way. Measured at 38% incidence live.
    expect(toMergeStateFromStatus("CANNOT_BE_MERGED_RECHECK", false, "DISCUSSIONS_NOT_RESOLVED")).toBe(
      "unknown",
    );
  });

  test("approvals syncing is not yet computed", () => {
    expect(toMergeStateFromStatus("CAN_BE_MERGED", false, "APPROVALS_SYNCING")).toBe("unknown");
  });
});

describe("verdict", () => {
  test("a blocking reviewer is changes-requested", () => {
    expect(verdictOf(mr({ changeRequesters: { nodes: [{ username: "bob" }] } }))).toBe(
      "changes-requested",
    );
  });

  test("the detailed status can also report it", () => {
    expect(verdictOf(mr({ detailedMergeStatus: "REQUESTED_CHANGES" }))).toBe(
      "changes-requested",
    );
  });

  test("a null changeRequesters is a capability gap, not an absence of blockers", () => {
    // Free-tier projects return null where paid ones return an empty connection.
    // It must not be read as "nobody blocked" — but there is nothing else to
    // report either, so the verdict falls through rather than inventing one.
    expect(verdictOf(mr({ changeRequesters: null }))).toBe("review-optional");
  });

  test("an approver is approved", () => {
    expect(verdictOf(mr({ approvedBy: { nodes: [{ username: "bob" }] } }))).toBe("approved");
  });

  test("required approvals with none given is awaiting-review", () => {
    expect(verdictOf(mr({ approvalsRequired: 2 }))).toBe("awaiting-review");
  });

  test("no requirement and no approval is review-optional", () => {
    expect(verdictOf(mr({ approvalsRequired: 0 }))).toBe("review-optional");
  });
});

describe("standing", () => {
  test("authorship wins", () => {
    expect(standingOf(mr({ author: { username: VIEWER } }), VIEWER)).toBe("mine");
  });

  test("an unreviewed request of me is awaiting-me", () => {
    expect(
      standingOf(mr({ reviewers: { nodes: [reviewer(VIEWER, "UNREVIEWED")] } }), VIEWER),
    ).toBe("awaiting-me");
    expect(
      standingOf(mr({ reviewers: { nodes: [reviewer(VIEWER, "REVIEW_STARTED")] } }), VIEWER),
    ).toBe("awaiting-me");
  });

  test("my blocking review is i-requested-changes", () => {
    expect(
      standingOf(
        mr({ reviewers: { nodes: [reviewer(VIEWER, "REQUESTED_CHANGES")] } }),
        VIEWER,
      ),
    ).toBe("i-requested-changes");
  });

  test("my approval is i-approved", () => {
    expect(
      standingOf(mr({ reviewers: { nodes: [reviewer(VIEWER, "APPROVED")] } }), VIEWER),
    ).toBe("i-approved");
  });

  test("a comment of mine with no review is i-commented", () => {
    expect(standingOf(mr({ commenters: { nodes: [{ username: VIEWER }] } }), VIEWER)).toBe(
      "i-commented",
    );
  });

  test("someone else's involvement is not mine", () => {
    expect(
      standingOf(mr({ reviewers: { nodes: [reviewer("bob", "UNREVIEWED")] } }), VIEWER),
    ).toBe("not-involved");
  });
});

describe("stale block", () => {
  test("is approximate, never exact", () => {
    // GitLab records no commit against a review state, so the sha comparison
    // GitHub uses cannot be ported.
    const stale = staleBlockOf(
      mr({
        reviewers: { nodes: [reviewer(VIEWER, "REQUESTED_CHANGES", "2026-01-01T00:00:00Z")] },
        mergeRequestDiffs: { nodes: [{ createdAt: "2026-02-01T00:00:00Z" }] },
      }),
      VIEWER,
    );
    expect(stale).toEqual({ value: true, precision: "approximate" });
  });

  test("a review newer than the diff is fresh", () => {
    expect(
      staleBlockOf(
        mr({
          reviewers: {
            nodes: [reviewer(VIEWER, "REQUESTED_CHANGES", "2026-03-01T00:00:00Z")],
          },
          mergeRequestDiffs: { nodes: [{ createdAt: "2026-02-01T00:00:00Z" }] },
        }),
        VIEWER,
      ),
    ).toEqual({ value: false, precision: "approximate" });
  });

  test("is null when the review carries no timestamp", () => {
    // 20% of the blocking cohort when measured — undecidable, not fresh.
    expect(
      staleBlockOf(
        mr({ reviewers: { nodes: [reviewer(VIEWER, "REQUESTED_CHANGES", null)] } }),
        VIEWER,
      ),
    ).toBeNull();
  });

  test("is null when I am not blocking", () => {
    expect(staleBlockOf(mr(), VIEWER)).toBeNull();
    expect(
      staleBlockOf(mr({ reviewers: { nodes: [reviewer(VIEWER, "APPROVED")] } }), VIEWER),
    ).toBeNull();
  });

  test("compares across timezone offsets correctly", () => {
    // GitLab timestamps carry offsets; raw string comparison would misorder them.
    expect(
      staleBlockOf(
        mr({
          reviewers: {
            nodes: [reviewer(VIEWER, "REQUESTED_CHANGES", "2026-04-16T17:54:22+02:00")],
          },
          mergeRequestDiffs: { nodes: [{ createdAt: "2026-04-16T16:23:37Z" }] },
        }),
        VIEWER,
      ),
    ).toEqual({ value: true, precision: "approximate" });
  });
});

describe("stacks", () => {
  test("derives position from the chain, which includes self", () => {
    const chain = [
      { id: "gid://gitlab/MergeRequest/10", iid: "1" },
      { id: "gid://gitlab/MergeRequest/1", iid: "2" },
      { id: "gid://gitlab/MergeRequest/12", iid: "3" },
    ];
    expect(stacksOf(mr({ stack: chain }))).toEqual([
      {
        id: "gid://gitlab/MergeRequest/10",
        size: 3,
        position: 2,
        precision: "approximate",
      },
    ]);
  });

  test("is empty when unstacked", () => {
    // GitLab returns [] rather than null — 0 nulls in 246 sampled MRs.
    expect(stacksOf(mr({ stack: [] }))).toEqual([]);
    expect(stacksOf(mr({ stack: null }))).toEqual([]);
  });

  test("keys on the chain bottom so members agree", () => {
    const chain = [
      { id: "bottom", iid: "1" },
      { id: "gid://gitlab/MergeRequest/1", iid: "2" },
    ];
    expect(stacksOf(mr({ stack: chain }))[0]!.id).toBe("bottom");
  });
});

describe("involvement filter", () => {
  test("matches author, assignee, reviewer, commenter and participant", () => {
    expect(concernsViewer(mr({ author: { username: VIEWER } }), VIEWER)).toBe(true);
    expect(concernsViewer(mr({ assignees: { nodes: [{ username: VIEWER }] } }), VIEWER)).toBe(true);
    expect(
      concernsViewer(mr({ reviewers: { nodes: [reviewer(VIEWER, "UNREVIEWED")] } }), VIEWER),
    ).toBe(true);
    expect(concernsViewer(mr({ commenters: { nodes: [{ username: VIEWER }] } }), VIEWER)).toBe(true);
    expect(concernsViewer(mr({ participants: { nodes: [{ username: VIEWER }] } }), VIEWER)).toBe(
      true,
    );
  });

  test("rejects an MR that does not involve me", () => {
    // This filter is the whole reason the GitLab scan fetches then filters:
    // `involves:@me` has no GitLab equivalent.
    expect(concernsViewer(mr(), VIEWER)).toBe(false);
  });
});

describe("normalizeMergeRequest", () => {
  test("stamps the provider and uses iid as the number", () => {
    const row = normalizeMergeRequest(mr(), VIEWER);
    expect(row.provider).toBe("gitlab");
    expect(row.number).toBe(326);
  });

  test("trusts draft over the title prefix", () => {
    // Two of the driver's MRs are titled WIP: and report draft false, so title
    // parsing would misclassify a quarter of their board.
    const row = normalizeMergeRequest(mr({ title: "WIP: not really a draft" }), VIEWER);
    expect(row.draft).toBe(false);
  });

  test("carries the full project path as the repo", () => {
    expect(
      normalizeMergeRequest(mr({ project: { fullPath: "a/b/c" } }), VIEWER).repo,
    ).toBe("a/b/c");
  });

  test("validates the URL like any other remote string", () => {
    expect(normalizeMergeRequest(mr({ webUrl: "javascript:alert(1)" }), VIEWER).url).toBeNull();
  });

  test("sanitises the title", () => {
    expect(normalizeMergeRequest(mr({ title: "a\nb" }), VIEWER).title).toBe("a b");
  });

  test("counts opinionated reviews by others only", () => {
    const row = normalizeMergeRequest(
      mr({
        approvedBy: { nodes: [{ username: "alice" }, { username: VIEWER }] },
        changeRequesters: { nodes: [{ username: "bob" }] },
      }),
      VIEWER,
    );
    expect(row.otherReviews).toBe(2);
  });
});

/**
 * A merge-request connection as GitLab returns it. `count` is the project total,
 * which is what makes truncation visible.
 */
const connection = (nodes: unknown[], total = nodes.length, hasNextPage = false) => ({
  count: total,
  pageInfo: { hasNextPage },
  nodes,
});

describe("the scan", () => {
  test("reports a project whose open MRs did not fit in one page", async () => {
    // GitLab cannot filter by involvement server-side, so the scan breadth is the
    // whole project and everything past the window is discarded. Committing that
    // as a baseline would churn rows out as spurious `left` on every later sync.
    process.env.GITLAB_TOKEN = "t";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            currentUser: { username: VIEWER },
            projects: {
              nodes: [
                {
                  fullPath: "gitlab-org/gitlab",
                  mergeRequests: connection([mr({ author: { username: VIEWER } })], 3075, true),
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const result = await gitlab.scan(["gitlab-org/gitlab"], "t");
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toInclude("3075");
    // The rows it did see are still returned — the caller decides what a partial
    // scan means, and it must not commit.
    expect(result.rows).toHaveLength(1);
  });

  test("a project that fits reports no failure", async () => {
    process.env.GITLAB_TOKEN = "t";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            currentUser: { username: VIEWER },
            projects: {
              nodes: [
                {
                  fullPath: "g/s/p",
                  mergeRequests: connection([mr({ author: { username: VIEWER } })]),
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    expect((await gitlab.scan(["g/s/p"], "t")).failed).toEqual([]);
  });

  test("reports a project GitLab silently omitted", async () => {
    // A path GitLab cannot see is dropped with HTTP 200 and no error, so a typo
    // is otherwise indistinguishable from a project with no open MRs.
    process.env.GITLAB_TOKEN = "t";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            currentUser: { username: VIEWER },
            projects: {
              nodes: [{ fullPath: "g/s/real", mergeRequests: connection([]) }],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const result = await gitlab.scan(["g/s/real", "g/s/typo"], "t");
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toInclude("g/s/typo");
    expect(result.viewer).toBe(VIEWER);
  });

  test("filters out MRs that do not concern the viewer", async () => {
    process.env.GITLAB_TOKEN = "t";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            currentUser: { username: VIEWER },
            projects: {
              nodes: [
                {
                  fullPath: "g/s/p",
                  mergeRequests: connection([
                    mr({ id: "mine", author: { username: VIEWER } }),
                    mr({ id: "theirs" }),
                  ]),
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const result = await gitlab.scan(["g/s/p"], "t");
    expect(result.rows.map((r) => r.id)).toEqual(["mine"]);
    expect(result.failed).toEqual([]);
  });

  test("makes no request when nothing is configured", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const result = await gitlab.scan([], "t");
    expect(called).toBe(false);
    expect(result.rows).toEqual([]);
  });

  test("surfaces a GraphQL error rather than rendering holes", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "boom" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(gitlab.scan(["g/s/p"], "t")).rejects.toThrow(/boom/);
  });
});

describe("a reviewer's outstanding request", () => {
  const reviewer = (reviewState: string | null) =>
    mr({
      reviewers: {
        nodes: [
          {
            username: VIEWER,
            mergeRequestInteraction: reviewState === null ? null : { reviewState },
          },
        ],
      },
    });

  test("a withdrawn approval is still awaiting me", () => {
    // UNAPPROVED means the reviewer took their approval back, so the review is
    // outstanding again. Reading it as not-involved silently empties bucket 1.
    expect(standingOf(reviewer("UNAPPROVED"), VIEWER)).toBe("awaiting-me");
  });

  test("a missing interaction record is still awaiting me", () => {
    // Nothing is known, and presence on the reviewer list *is* the request.
    expect(standingOf(reviewer(null), VIEWER)).toBe("awaiting-me");
  });

  test("an unrecognised state defaults to awaiting me", () => {
    // Testing for the settled states rather than the unsettled ones means a state
    // GitLab adds later shows up rather than vanishing.
    expect(standingOf(reviewer("SOMETHING_GITLAB_ADDED_LATER"), VIEWER)).toBe("awaiting-me");
  });

  test("marked as reviewed reads as a comment, not absence", () => {
    expect(standingOf(reviewer("REVIEWED"), VIEWER)).toBe("i-commented");
  });

  test("the settled states still win", () => {
    expect(standingOf(reviewer("APPROVED"), VIEWER)).toBe("i-approved");
    expect(standingOf(reviewer("REQUESTED_CHANGES"), VIEWER)).toBe("i-requested-changes");
  });

  test("someone else's request is not mine", () => {
    const theirs = mr({
      reviewers: { nodes: [{ username: "alice", mergeRequestInteraction: null }] },
    });
    expect(standingOf(theirs, VIEWER)).toBe("not-involved");
  });
});

describe("verdict on a free-tier project", () => {
  test("a blocking reviewer counts even where changeRequesters is null", () => {
    // `changeRequesters` is null on the free tier, so without the reviewer states a
    // row renders the OPEN badge while sitting in "I blocked it, and it moved".
    const blocked = mr({
      changeRequesters: null,
      reviewers: {
        nodes: [
          { username: "alice", mergeRequestInteraction: { reviewState: "REQUESTED_CHANGES" } },
        ],
      },
    });
    expect(verdictOf(blocked)).toBe("changes-requested");
  });

  test("a non-blocking reviewer does not fabricate one", () => {
    const clean = mr({
      changeRequesters: null,
      reviewers: {
        nodes: [{ username: "alice", mergeRequestInteraction: { reviewState: "UNREVIEWED" } }],
      },
    });
    expect(verdictOf(clean)).not.toBe("changes-requested");
  });
});

describe("a malformed iid", () => {
  test("cannot poison the numeric sort", () => {
    // NaN passes `isPullRequest` (`typeof NaN` is "number") and then poisons every
    // `a.number - b.number` comparison it reaches.
    expect(normalizeMergeRequest(mr({ iid: "not-a-number" }), VIEWER).number).toBe(0);
    expect(normalizeMergeRequest(mr({ iid: "42" }), VIEWER).number).toBe(42);
  });
});

describe("server-supplied error text", () => {
  test("prefers a structural code over free text", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          errors: [{ message: "long prose nobody wants", extensions: { code: "FORBIDDEN" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    await expect(gitlab.scan(["g/s/p"], "t")).rejects.toThrow(/FORBIDDEN/);
  });

  test("strips control characters when there is no code", async () => {
    // The message reaches the TUI header and stderr. Raw escapes there can clear
    // the screen and paint fabricated rows above the real board.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ errors: [{ message: "a\u001b[2Jb\u0007c\r\nd" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const error = (await gitlab.scan(["g/s/p"], "t").catch((e: Error) => e)) as Error;
    expect(error.message).not.toInclude("\u001b");
    expect(error.message).not.toInclude("\u0007");
    expect(error.message).not.toInclude("\n");
  });
});

describe("token freshness", () => {
  // 17:10 local, the moment the real 401 was reproduced.
  const now = new Date("2026-08-19T17:10:00+02:00");

  test("a personal access token is never refreshed", () => {
    // PATs are long-lived, and glab stores no expiry for them.
    expect(needsRefresh("false", "", now)).toBe(false);
    expect(needsRefresh("false", "2020-01-01T00:00:00+02:00", now)).toBe(false);
  });

  test("a lapsed OAuth token is refreshed", () => {
    // The observed failure: `glab config get token` hands back the stored token
    // without refreshing it, so a token that expired since the last glab command
    // reached the API dead and the scan failed with a bare 401.
    expect(needsRefresh("true", "2026-08-19T15:08:00+02:00", now)).toBe(true);
  });

  test("a live OAuth token is used as it stands", () => {
    // No wasted round trip in the common case.
    expect(needsRefresh("true", "2026-08-19T19:08:00+02:00", now)).toBe(false);
  });

  test("a token about to lapse is refreshed first", () => {
    // A scan takes seconds and can outlive a token with none left.
    expect(needsRefresh("true", "2026-08-19T17:10:30+02:00", now)).toBe(true);
  });

  test("an unreadable expiry is refreshed rather than trusted", () => {
    // Cannot be shown to be live, and the cost of guessing wrong is a bare 401.
    expect(needsRefresh("true", "", now)).toBe(true);
    expect(needsRefresh("true", "not-a-date", now)).toBe(true);
  });
});

/** One census node as the live API returns it: string `iid`, lowercase `state`. */
function censusNode(over: Record<string, unknown> = {}) {
  return {
    iid: "1",
    title: "feat: something",
    webUrl: "https://gitlab.com/g/s/p/-/merge_requests/1",
    state: "opened",
    draft: false,
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-02T00:00:00Z",
    mergedAt: null,
    closedAt: null,
    author: { username: "alice" },
    mergeUser: null,
    diffStatsSummary: { additions: 3, deletions: 1, fileCount: 2 },
    approvedBy: { nodes: [] },
    reviewers: { nodes: [] },
    ...over,
  };
}

interface CensusPage {
  nodes: unknown[];
  hasNextPage?: boolean;
  endCursor?: string | null;
}

/**
 * Serves census pages in order and records the variables each request bound. The
 * last page repeats once the list is exhausted, which is what an unbounded cursor
 * looks like — the condition `MAX_PAGES` exists to stop.
 */
function serveCensus(pages: CensusPage[]) {
  const seen: Array<{ path: unknown; after: unknown; authorization: unknown }> = [];
  globalThis.fetch = (async (
    _url: unknown,
    init: { body: string; headers: Record<string, string> },
  ) => {
    const { variables } = JSON.parse(init.body) as {
      variables: { path: unknown; after: unknown };
    };
    seen.push({
      path: variables.path,
      after: variables.after,
      authorization: init.headers.authorization,
    });
    const page = pages[Math.min(seen.length - 1, pages.length - 1)]!;
    return new Response(
      JSON.stringify({
        data: {
          project: {
            mergeRequests: {
              count: page.nodes.length,
              pageInfo: {
                hasNextPage: page.hasNextPage ?? false,
                endCursor: page.endCursor === undefined ? `cursor-${seen.length}` : page.endCursor,
              },
              nodes: page.nodes,
            },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return seen;
}

function serveBody(body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("the census walk", () => {
  test("stitches the pages a cursor hands back", async () => {
    process.env.GITLAB_TOKEN = "t";
    const seen = serveCensus([
      { nodes: [censusNode({ iid: "5" }), censusNode({ iid: "4" })], hasNextPage: true, endCursor: "cur1" },
      { nodes: [censusNode({ iid: "3" })] },
    ]);

    const census = await gitlabCensus.censusRepo("g/s/p", null);

    expect(census.prs.map((p) => p.number)).toEqual([5, 4, 3]);
    expect(census.failed).toBeNull();
    expect(census.truncated).toBe(false);
    // The path is bound as a variable, never interpolated into the document.
    expect(seen.map((r) => r.path)).toEqual(["g/s/p", "g/s/p"]);
    // First page unanchored, second anchored on the cursor the first returned.
    expect(seen.map((r) => r.after)).toEqual([null, "cur1"]);
  });

  test("stops when the cursor stops, not when the count runs out", async () => {
    // `hasNextPage` true with no cursor is nowhere to go: following it would
    // re-request page one until MAX_PAGES.
    process.env.GITLAB_TOKEN = "t";
    const seen = serveCensus([{ nodes: [censusNode()], hasNextPage: true, endCursor: null }]);
    const census = await gitlabCensus.censusRepo("g/s/p", null);
    expect(seen).toHaveLength(1);
    expect(census.prs).toHaveLength(1);
  });

  test("reports a prefix as truncated rather than as the whole history", async () => {
    process.env.GITLAB_TOKEN = "t";
    // Every page claims another, with a fresh cursor each time — a runaway walk.
    const seen = serveCensus([{ nodes: [censusNode()], hasNextPage: true }]);

    const census = await gitlabCensus.censusRepo("g/s/p", null);

    expect(seen).toHaveLength(MAX_PAGES);
    expect(census.prs).toHaveLength(MAX_PAGES);
    expect(census.truncated).toBe(true);
    // Truncated is not failed: the rows it did read are real.
    expect(census.failed).toBeNull();
  });

  test("a watermark ends the walk at the first row the caller already holds", async () => {
    process.env.GITLAB_TOKEN = "t";
    const seen = serveCensus([
      {
        nodes: [
          censusNode({ iid: "3", createdAt: "2026-06-03T00:00:00Z" }),
          censusNode({ iid: "2", createdAt: "2026-06-02T00:00:00Z" }),
          censusNode({ iid: "1", createdAt: "2026-05-01T00:00:00Z" }),
        ],
        hasNextPage: true,
      },
    ]);

    const census = await gitlabCensus.censusRepo("g/s/p", "2026-06-02T00:00:00Z");

    expect(census.prs.map((p) => p.number)).toEqual([3]);
    // And it did not ask for the page after the one it stopped inside.
    expect(seen).toHaveLength(1);
  });

  test("an offset-bearing watermark compares as the same instant", async () => {
    // Both sides are canonicalised before the string compare. Without that,
    // `2026-06-02T02:00:00+02:00` sorts after `2026-06-03T00:00:00Z`.
    process.env.GITLAB_TOKEN = "t";
    serveCensus([
      {
        nodes: [
          censusNode({ iid: "3", createdAt: "2026-06-03T00:00:00Z" }),
          censusNode({ iid: "2", createdAt: "2026-06-02T00:00:00Z" }),
        ],
        hasNextPage: true,
      },
    ]);

    const census = await gitlabCensus.censusRepo("g/s/p", "2026-06-02T02:00:00+02:00");
    expect(census.prs.map((p) => p.number)).toEqual([3]);
  });

  test("a cancelled census rejects instead of blaming the project", async () => {
    process.env.GITLAB_TOKEN = "t";
    const seen = serveCensus([{ nodes: [censusNode()] }]);
    await expect(
      gitlabCensus.censusRepo("g/s/p", null, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });
});

describe("a project the census cannot read", () => {
  test("a null project is a failure with no rows, not an empty history", async () => {
    // HTTP 200, no `errors`, `project: null` — verified live against a typo path.
    process.env.GITLAB_TOKEN = "t";
    serveBody({ data: { project: null } });

    const census = await gitlabCensus.censusRepo("g/s/typo", null);

    expect(census.failed).toInclude("g/s/typo");
    expect(census.failed).toInclude("unreachable");
    expect(census.prs).toEqual([]);
    expect(census.reviews).toEqual([]);
    expect(census.truncated).toBe(false);
  });

  test("a GraphQL error is reported, never thrown at the caller", async () => {
    // One unreadable project must not abort a census over the others.
    process.env.GITLAB_TOKEN = "t";
    serveBody({ errors: [{ message: "boom", extensions: { code: "FORBIDDEN" } }] });

    const census = await gitlabCensus.censusRepo("g/s/p", null);
    expect(census.failed).toInclude("FORBIDDEN");
    expect(census.prs).toEqual([]);
  });

  test("the token never reaches the failure text", async () => {
    // GitLab echoes request fragments on some rejections, and a census failure is
    // printed. The exact secret is replaced, whatever shape it has.
    process.env.GITLAB_TOKEN = "glpat-supersecret";
    serveBody({ errors: [{ message: "invalid token glpat-supersecret" }] });

    const census = await gitlabCensus.censusRepo("g/s/p", null);
    expect(census.failed).not.toBeNull();
    expect(census.failed).not.toInclude("glpat-supersecret");
    expect(census.failed).toInclude("***");
  });
});

describe("a censused merge request", () => {
  test("carries the iid as a number and the state in the taxonomy", async () => {
    process.env.GITLAB_TOKEN = "t";
    serveCensus([
      {
        nodes: [
          censusNode({ iid: "329", state: "opened" }),
          censusNode({
            iid: "328",
            state: "merged",
            mergedAt: "2026-07-29T13:58:43Z",
            mergeUser: { username: "bob" },
          }),
          censusNode({
            iid: "320",
            state: "closed",
            closedAt: "2026-04-22T12:38:14Z",
            updatedAt: "2026-05-01T00:00:00Z",
          }),
          censusNode({ iid: "300", state: "locked", updatedAt: "2026-05-02T00:00:00Z" }),
        ],
      },
    ]);

    const census = await gitlabCensus.censusRepo("g/s/p", null);
    const [open, merged, closed, locked] = census.prs;

    // `iid` arrives as a string; a numeric field that stayed a string would break
    // every keyed lookup downstream.
    expect(open?.number).toBe(329);
    expect(open?.state).toBe("open");
    expect(open?.mergedAt).toBeNull();
    expect(open?.closedAt).toBeNull();

    expect(merged?.state).toBe("merged");
    expect(merged?.mergedAt).toBe("2026-07-29T13:58:43.000Z");
    expect(merged?.mergedBy).toBe("bob");

    // The selected `closedAt` wins over the later `updatedAt`, which drifts every
    // time somebody comments on a closed MR.
    expect(closed?.state).toBe("closed");
    expect(closed?.closedAt).toBe("2026-04-22T12:38:14.000Z");

    // `locked` folds into closed, and carries no closing date of its own.
    expect(locked?.state).toBe("closed");
    expect(locked?.closedAt).toBe("2026-05-02T00:00:00.000Z");

    // Merge authorship is only meaningful on a merged MR.
    expect(open?.mergedBy).toBe("");
  });

  test("a malformed iid cannot poison a numeric field", async () => {
    process.env.GITLAB_TOKEN = "t";
    serveCensus([{ nodes: [censusNode({ iid: "not-a-number" })] }]);
    expect((await gitlabCensus.censusRepo("g/s/p", null)).prs[0]?.number).toBe(0);
  });

  test("a hidden author and an uncomputed diff read as empty, not as holes", async () => {
    process.env.GITLAB_TOKEN = "t";
    serveCensus([{ nodes: [censusNode({ author: null, diffStatsSummary: null })] }]);
    const row = (await gitlabCensus.censusRepo("g/s/p", null)).prs[0];
    expect(row?.author).toBe("");
    expect(row?.additions).toBe(0);
    expect(row?.files).toBe(0);
  });
});

describe("census review acts", () => {
  test("an approval recorded twice is one act", async () => {
    // `approvedBy` and a reviewer's APPROVED `reviewState` describe the same act.
    process.env.GITLAB_TOKEN = "t";
    serveCensus([
      {
        nodes: [
          censusNode({
            iid: "7",
            approvedBy: { nodes: [{ username: "alice" }] },
            reviewers: {
              nodes: [
                { username: "alice", mergeRequestInteraction: { reviewState: "APPROVED" } },
                { username: "bob", mergeRequestInteraction: { reviewState: "REQUESTED_CHANGES" } },
                { username: "carol", mergeRequestInteraction: { reviewState: "UNREVIEWED" } },
                { username: "dave", mergeRequestInteraction: null },
              ],
            },
          }),
        ],
      },
    ]);

    const { reviews } = await gitlabCensus.censusRepo("g/s/p", null);

    expect(reviews.map((r) => `${r.reviewer}:${r.act}`)).toEqual([
      "alice:approved",
      "bob:changes-requested",
    ]);
    // Every row belongs to the MR it came from.
    expect(reviews.every((r) => r.number === 7 && r.repo === "g/s/p")).toBe(true);
  });

  test("two different acts by one reviewer are two rows", async () => {
    // A withdrawn-then-blocked reviewer holds both; only the identical pair merges.
    process.env.GITLAB_TOKEN = "t";
    serveCensus([
      {
        nodes: [
          censusNode({
            approvedBy: { nodes: [{ username: "alice" }] },
            reviewers: {
              nodes: [
                { username: "alice", mergeRequestInteraction: { reviewState: "REQUESTED_CHANGES" } },
              ],
            },
          }),
        ],
      },
    ]);

    expect(
      (await gitlabCensus.censusRepo("g/s/p", null)).reviews.map((r) => r.act),
    ).toEqual(["approved", "changes-requested"]);
  });

  test("no review carries a time, and the census says so", async () => {
    // GitLab attaches no timestamp to either source, so latency is unknowable
    // rather than zero — a fabricated `at` would read as an instant review.
    process.env.GITLAB_TOKEN = "t";
    serveCensus([
      {
        nodes: [
          censusNode({
            approvedBy: { nodes: [{ username: "alice" }] },
            reviewers: {
              nodes: [{ username: "bob", mergeRequestInteraction: { reviewState: "REVIEWED" } }],
            },
          }),
        ],
      },
    ]);

    const census = await gitlabCensus.censusRepo("g/s/p", null);
    expect(census.reviews).toHaveLength(2);
    expect(census.reviews.every((r) => r.at === null)).toBe(true);
    expect(census.reviewPrecision).toBe("approximate");
  });
});

describe("a census under a lapsing OAuth token", () => {
  test("refreshes through glab before the first page", async () => {
    // A census is several pages; a two-hour OAuth token that lapses mid-walk
    // abandons a multi-minute walk with a bare 401.
    delete process.env.GITLAB_TOKEN;
    const calls: string[][] = [];
    const stored: Record<string, string> = {
      is_oauth2: "true",
      // Fixed and firmly past, so the decision needs no clock control.
      oauth2_expiry_date: "2020-01-01T00:00:00Z",
      token: "glpat-fresh",
    };
    Bun.spawn = ((cmd: string[]) => {
      calls.push(cmd);
      const answer = cmd[1] === "config" ? (stored[cmd[3] ?? ""] ?? "") : "";
      return {
        stdout: new Blob([answer]).stream(),
        stderr: new Blob([""]).stream(),
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;

    const seen = serveCensus([{ nodes: [censusNode()] }]);
    const census = await gitlabCensus.censusRepo("g/s/p", null);

    // `glab api /user` is the call that makes glab refresh and write back.
    const refreshed = calls.findIndex((c) => c[1] === "api" && c[2] === "/user");
    expect(refreshed).toBeGreaterThanOrEqual(0);
    // ...and it happened before the token was read, so before the walk.
    expect(calls.findIndex((c) => c[3] === "token")).toBeGreaterThan(refreshed);
    expect(seen[0]?.authorization).toBe("Bearer glpat-fresh");
    expect(census.failed).toBeNull();
  });

  test("a personal access token is read without a refresh round trip", async () => {
    delete process.env.GITLAB_TOKEN;
    const calls: string[][] = [];
    Bun.spawn = ((cmd: string[]) => {
      calls.push(cmd);
      const answer = cmd[3] === "token" ? "glpat-stored" : "false";
      return {
        stdout: new Blob([answer]).stream(),
        stderr: new Blob([""]).stream(),
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;

    const seen = serveCensus([{ nodes: [censusNode()] }]);
    await gitlabCensus.censusRepo("g/s/p", null);

    expect(calls.some((c) => c[1] === "api")).toBe(false);
    expect(seen[0]?.authorization).toBe("Bearer glpat-stored");
  });
});
