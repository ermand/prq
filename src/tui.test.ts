import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { normalize, type PullRequest, type RawPullRequest } from "./domain";
import { mountApp, type AppOptions } from "./tui";

function pr(over: Partial<PullRequest> = {}): PullRequest {
  const base = normalize(
    {
      id: `PR_${over.number ?? 1}`,
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

function options(over: Partial<AppOptions> = {}): AppOptions {
  return {
    prs: [],
    changes: [],
    viewer: "ermand",
    repos: ["org/repo"],
    lastSync: new Date(),
    baselineReset: false,
    sync: async () => ({
      prs: [],
      changes: [],
      failures: [],
      at: new Date(),
      viewer: "ermand",
      baselineReset: false,
    }),
    ...over,
  };
}

async function paint(over: Partial<AppOptions> = {}) {
  const harness = await createTestRenderer({ width: 100, height: 20 });
  mountApp(harness.renderer, options(over));
  await harness.renderOnce();
  return harness;
}

describe("the painted dashboard", () => {
  test("shows the status line", async () => {
    const h = await paint({ prs: [pr({ standing: "awaiting-me" })] });
    const frame = h.captureCharFrame();
    expect(frame).toInclude("ermand");
    expect(frame).toInclude("1 PR");
    expect(frame).toInclude("1 repo");
    h.renderer.destroy();
  });

  test("renders bucket headers and PR rows", async () => {
    const h = await paint({
      prs: [
        pr({ number: 1, standing: "awaiting-me", title: "Needs my eyes" }),
        pr({ number: 2, standing: "mine", checks: "pending", title: "My own work" }),
      ],
    });
    const frame = h.captureCharFrame();
    expect(frame).toInclude("Awaiting me");
    expect(frame).toInclude("Needs my eyes");
    expect(frame).toInclude("Mine, waiting");
    expect(frame).toInclude("My own work");
    h.renderer.destroy();
  });

  test("orders buckets, queue before my own work", async () => {
    const h = await paint({
      prs: [
        pr({ number: 2, standing: "mine", checks: "pending" }),
        pr({ number: 1, standing: "awaiting-me" }),
      ],
    });
    const frame = h.captureCharFrame();
    expect(frame.indexOf("Awaiting me")).toBeLessThan(frame.indexOf("Mine, waiting"));
    h.renderer.destroy();
  });

  test("marks the cursor on the first selectable row", async () => {
    const h = await paint({ prs: [pr({ standing: "awaiting-me" })] });
    expect(h.captureCharFrame()).toInclude("▸");
    h.renderer.destroy();
  });

  test("shows the stack position", async () => {
    const h = await paint({
      prs: [pr({ standing: "awaiting-me", stacks: [{ id: "5", size: 3, position: 2, precision: "exact" }] })],
    });
    expect(h.captureCharFrame()).toInclude("2/3");
    h.renderer.destroy();
  });

  test("says nothing has ever been synced", async () => {
    const h = await paint({ lastSync: null, viewer: "" });
    const frame = h.captureCharFrame();
    expect(frame).toInclude("not synced");
    expect(frame).toInclude("never synced");
    h.renderer.destroy();
  });

  test("a first sync reads as baseline set, not as nothing changed", async () => {
    const h = await paint({ baselineReset: true, prs: [pr({ standing: "awaiting-me" })] });
    expect(h.captureCharFrame()).toInclude("baseline set");
    h.renderer.destroy();
  });

  test("marks a changed row and counts it", async () => {
    const h = await paint({
      prs: [pr({ id: "PR_1", standing: "awaiting-me", title: "moved one" })],
      changes: [{ prId: "PR_1", kind: "retargeted", from: "a", to: "b" }],
    });
    const frame = h.captureCharFrame();
    expect(frame).toInclude("retargeted");
    expect(frame).toInclude("1 changed");
    h.renderer.destroy();
  });

  test("shows only the most significant change per row", async () => {
    const h = await paint({
      prs: [pr({ id: "PR_1", standing: "awaiting-me" })],
      changes: [
        { prId: "PR_1", kind: "bucket", from: "7", to: "1" },
        { prId: "PR_1", kind: "review-requested", from: "x", to: "y" },
      ],
    });
    const frame = h.captureCharFrame();
    expect(frame).toInclude("asked");
    expect(frame).not.toInclude("moved");
    h.renderer.destroy();
  });

  test("says so when there is nothing to review", async () => {
    const h = await paint();
    expect(h.captureCharFrame()).toInclude("nothing to review");
    h.renderer.destroy();
  });

  test("shows the keymap", async () => {
    const h = await paint({ prs: [pr({ standing: "awaiting-me" })] });
    expect(h.captureCharFrame()).toInclude("q quit");
    h.renderer.destroy();
  });
});

describe("keyboard", () => {
  test("j moves the cursor down a row", async () => {
    const h = await paint({
      prs: [
        pr({ number: 1, standing: "awaiting-me", title: "First one" }),
        pr({ number: 2, standing: "awaiting-me", title: "Second one" }),
      ],
    });
    const before = h.captureCharFrame();
    h.mockInput.pressKey("j");
    await h.renderOnce();
    const after = h.captureCharFrame();
    expect(after).not.toBe(before);
    // The marker moved off the first row and onto the second.
    const line = (frame: string, needle: string) =>
      frame.split("\n").find((l) => l.includes(needle)) ?? "";
    expect(line(before, "First one")).toInclude("▸");
    expect(line(after, "Second one")).toInclude("▸");
    h.renderer.destroy();
  });

  test("g drops the grouping", async () => {
    const h = await paint({ prs: [pr({ standing: "awaiting-me" })] });
    expect(h.captureCharFrame()).toInclude("Awaiting me");
    h.mockInput.pressKey("g");
    await h.renderOnce();
    const frame = h.captureCharFrame();
    expect(frame).not.toInclude("Awaiting me");
    expect(frame).toInclude("flat");
    h.renderer.destroy();
  });

  test("/ opens the filter and typing narrows the list", async () => {
    const h = await paint({
      prs: [
        pr({ number: 1, standing: "awaiting-me", title: "alpha work" }),
        pr({ number: 2, standing: "awaiting-me", title: "beta work" }),
      ],
    });
    h.mockInput.pressKey("/");
    for (const ch of "alpha") h.mockInput.pressKey(ch);
    await h.renderOnce();
    const frame = h.captureCharFrame();
    expect(frame).toInclude("filter: alpha");
    expect(frame).toInclude("alpha work");
    expect(frame).not.toInclude("beta work");
    h.renderer.destroy();
  });

  test("s focuses the stack the cursor is on, and leaves it again", async () => {
    const h = await paint({
      prs: [
        pr({ number: 1, standing: "awaiting-me", title: "stacked", stacks: [{ id: "5", size: 2, position: 1, precision: "exact" }] }),
        pr({ number: 2, standing: "awaiting-me", title: "unstacked" }),
      ],
    });
    h.mockInput.pressKey("s");
    await h.renderOnce();
    expect(h.captureCharFrame()).toInclude("stacked");
    expect(h.captureCharFrame()).not.toInclude("unstacked");
    h.mockInput.pressKey("s");
    await h.renderOnce();
    expect(h.captureCharFrame()).toInclude("unstacked");
    h.renderer.destroy();
  });
});

describe("hostile data", () => {
  test("a PR with no usable link still renders", async () => {
    // `url` is null whenever the API handed us something that was not https.
    const h = await paint({
      prs: [pr({ standing: "awaiting-me", title: "no link here", url: null })],
    });
    expect(h.captureCharFrame()).toInclude("no link here");
    h.renderer.destroy();
  });

  test("pressing o on a linkless PR says so instead of spawning", async () => {
    const h = await paint({
      prs: [pr({ standing: "awaiting-me", url: null })],
    });
    h.mockInput.pressKey("o");
    await h.renderOnce();
    expect(h.captureCharFrame()).toInclude("no usable link");
    h.renderer.destroy();
  });

  test("a title with a newline cannot blank the dashboard", async () => {
    // normalize() strips control characters, so the one-row-per-PR assumption
    // in the viewport maths holds. Rendering the raw string would push the
    // header and footer out of the root box.
    const hostile = normalize(
      {
        id: "PR_9",
        number: 9,
        title: "line one\nline two\nline three",
        url: "https://github.com/org/repo/pull/9",
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
        viewerLatestReviewRequest: { asCodeOwner: false },
        latestOpinionatedReviews: { nodes: [] },
        stack: null,
        stackEntry: null,
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
      },
      "ermand",
    );
    const h = await paint({
      prs: [hostile, pr({ number: 2, standing: "awaiting-me", title: "innocent row" })],
    });
    const frame = h.captureCharFrame();
    expect(frame).toInclude("ermand");
    expect(frame).toInclude("innocent row");
    expect(frame).toInclude("q quit");
    h.renderer.destroy();
  });
});

describe("sync", () => {
  test("S syncs and reports the change count", async () => {
    const h = await paint({
      prs: [pr({ id: "PR_1", standing: "awaiting-me" })],
      sync: async () => ({
        prs: [pr({ id: "PR_1", standing: "awaiting-me", checks: "failing" })],
        changes: [{ prId: "PR_1", kind: "checks", from: "success", to: "failing" }],
        failures: [],
        at: new Date(),
        viewer: "ermand",
        baselineReset: false,
      }),
    });
    h.mockInput.pressKey("S");
    await h.renderOnce();
    await h.renderOnce();
    const frame = h.captureCharFrame();
    expect(frame).toInclude("1 PR changed");
    expect(frame).toInclude("1 changed");
    h.renderer.destroy();
  });

  test("lowercase s does not sync", async () => {
    // Sync is deliberate; it must not share a keystroke with navigation.
    let called = false;
    const h = await paint({
      prs: [pr({ standing: "awaiting-me" })],
      sync: async () => {
        called = true;
        return {
          prs: [],
          changes: [],
          failures: [],
          at: new Date(),
          viewer: "ermand",
          baselineReset: false,
        };
      },
    });
    h.mockInput.pressKey("s");
    await h.renderOnce();
    expect(called).toBe(false);
    h.renderer.destroy();
  });

  test("a partial sync says it was not committed", async () => {
    const h = await paint({
      prs: [pr({ standing: "awaiting-me" })],
      sync: async () => ({
        prs: [pr({ standing: "awaiting-me" })],
        changes: [],
        failures: ["review-requested:@me: GitHub returned 502"],
        at: new Date(),
        viewer: "ermand",
        baselineReset: false,
      }),
    });
    h.mockInput.pressKey("S");
    await h.renderOnce();
    await h.renderOnce();
    const frame = h.captureCharFrame();
    expect(frame).toInclude("INCOMPLETE");
    expect(frame).toInclude("502");
    expect(frame).toInclude("baseline unchanged");
    h.renderer.destroy();
  });

  test("a failed sync leaves the shown state alone", async () => {
    const h = await paint({
      prs: [pr({ standing: "awaiting-me", title: "still here" })],
      sync: async () => {
        throw new Error("network down");
      },
    });
    h.mockInput.pressKey("S");
    await h.renderOnce();
    await h.renderOnce();
    const frame = h.captureCharFrame();
    expect(frame).toInclude("still here");
    expect(frame).toInclude("sync failed");
    h.renderer.destroy();
  });
});

describe("the changed filter", () => {
  test("c narrows to PRs that moved, and toggles back", async () => {
    const h = await paint({
      prs: [
        pr({ id: "PR_1", standing: "awaiting-me", title: "moved one" }),
        pr({ id: "PR_2", number: 2, standing: "awaiting-me", title: "still one" }),
      ],
      changes: [{ prId: "PR_1", kind: "checks", from: "success", to: "failing" }],
    });
    h.mockInput.pressKey("c");
    await h.renderOnce();
    let frame = h.captureCharFrame();
    expect(frame).toInclude("moved one");
    expect(frame).not.toInclude("still one");
    expect(frame).toInclude("changed only");

    h.mockInput.pressKey("c");
    await h.renderOnce();
    frame = h.captureCharFrame();
    expect(frame).toInclude("still one");
    h.renderer.destroy();
  });

  test("c says so when nothing changed rather than emptying the list", async () => {
    const h = await paint({ prs: [pr({ standing: "awaiting-me", title: "here" })] });
    h.mockInput.pressKey("c");
    await h.renderOnce();
    const frame = h.captureCharFrame();
    expect(frame).toInclude("nothing changed");
    expect(frame).toInclude("here");
    h.renderer.destroy();
  });
});
