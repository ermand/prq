import { describe, expect, test } from "bun:test";
import type { Provider, PullRequest } from "../../../src/domain";
import type { ProviderOutcome, SyncOutcome } from "../../../src/engine";
import { toPayload } from "./payload";

const NOW = new Date("2026-08-20T12:00:00.000Z");

function pr(id: string, provider: Provider = "github"): PullRequest {
  return {
    id,
    provider,
    number: 1,
    title: "t",
    url: "https://github.com/o/r/pull/1",
    repo: "o/r",
    author: "a",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    headOid: "abc",
    baseRef: "main",
    draft: false,
    verdict: "awaiting-review",
    standing: "awaiting-me",
    checks: "none",
    merge: "clean",
    staleBlock: null,
    viaCodeOwners: false,
    otherReviews: 0,
    stacks: [],
  };
}

function outcome(byProvider: Partial<ProviderOutcome>[]): SyncOutcome {
  const full = byProvider.map((p) => ({
    provider: "github" as Provider,
    sync: null,
    prs: [],
    changes: [],
    failures: [],
    baselineReset: false,
    at: null,
    viewer: "",
    ...p,
  }));
  return {
    byProvider: full,
    prs: full.flatMap((p) => p.prs),
    changes: full.flatMap((p) => p.changes),
    failures: full.flatMap((p) => p.failures),
  };
}

const PROJECTS: Record<Provider, string[]> = {
  github: ["o/r"],
  gitlab: ["g/s/p"],
};

describe("toPayload", () => {
  test("pins the clock rather than reading it, so SSR and hydration agree", () => {
    // Ages are rendered against this value on both sides of hydration. Reading
    // the clock twice would differ by the milliseconds between them and React
    // would report a mismatch.
    const payload = toPayload(outcome([]), PROJECTS, NOW);
    expect(payload.now).toBe("2026-08-20T12:00:00.000Z");
  });

  test("converts every Date to ISO, because Date does not survive the wire", () => {
    const at = new Date("2026-08-19T09:30:00.000Z");
    const payload = toPayload(
      outcome([{ provider: "github", prs: [pr("a")], at, viewer: "me" }]),
      PROJECTS,
      NOW,
    );
    expect(payload.lastSync).toBe("2026-08-19T09:30:00.000Z");
    expect(payload.byProvider[0]?.at).toBe("2026-08-19T09:30:00.000Z");
  });

  test("reports the oldest baseline, so a fresh half cannot hide a stale one", () => {
    const payload = toPayload(
      outcome([
        { provider: "github", prs: [pr("a")], at: new Date("2026-08-20T11:00:00Z") },
        {
          provider: "gitlab",
          prs: [pr("b", "gitlab")],
          at: new Date("2026-08-01T11:00:00Z"),
        },
      ]),
      PROJECTS,
      NOW,
    );
    expect(payload.lastSync).toBe("2026-08-01T11:00:00.000Z");
  });

  test("a provider that never synced contributes no time at all", () => {
    const payload = toPayload(outcome([{ provider: "github" }]), PROJECTS, NOW);
    expect(payload.lastSync).toBeNull();
  });

  test("carries every provider's failures, since a failed scan stores none", () => {
    // The board reads these from the sync's return value: nothing was committed,
    // so re-reading the store afterwards cannot recover them.
    const payload = toPayload(
      outcome([
        { provider: "github", prs: [pr("a")] },
        { provider: "gitlab", failures: ["gitlab: unreachable"] },
      ]),
      PROJECTS,
      NOW,
    );
    expect(payload.failures).toEqual(["gitlab: unreachable"]);
    expect(payload.byProvider[1]?.failures).toEqual(["gitlab: unreachable"]);
    // The half that did answer is still shown.
    expect(payload.prs).toHaveLength(1);
  });

  test("one provider resetting its baseline marks the board", () => {
    const payload = toPayload(
      outcome([{ provider: "github" }, { provider: "gitlab", baselineReset: true }]),
      PROJECTS,
      NOW,
    );
    expect(payload.baselineReset).toBe(true);
  });

  test("joins the viewers that contributed rows, and dedupes them", () => {
    const payload = toPayload(
      outcome([
        { provider: "github", viewer: "me" },
        { provider: "gitlab", viewer: "me" },
      ]),
      PROJECTS,
      NOW,
    );
    expect(payload.viewer).toBe("me");
  });

  test("flattens both configured project lists for the header count", () => {
    const payload = toPayload(outcome([]), PROJECTS, NOW);
    expect(payload.projects).toEqual(["o/r", "g/s/p"]);
  });
});
