import { afterEach, describe, expect, test } from "bun:test";
import {
  concernsViewer,
  gitlab,
  normalizeMergeRequest,
  stacksOf,
  staleBlockOf,
  standingOf,
  toChecksFromPipeline,
  toMergeStateFromStatus,
  verdictOf,
} from "./gitlab";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
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
