import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { normalize } from "./domain";
import {
  ageMinutes,
  cacheKey,
  cachePath,
  isFresh,
  readCache,
  writeCache,
  type CacheEntry,
} from "./cache";

function entry(over: Partial<CacheEntry> = {}): CacheEntry {
  return {
    version: 1,
    key: "abc",
    fetchedAt: "2026-01-01T12:00:00Z",
    viewer: "ermand",
    prs: [],
    partial: false,
    failures: [],
    ...over,
  };
}

const at = (iso: string) => new Date(iso);

describe("cacheKey", () => {
  test("is order-independent", () => {
    expect(cacheKey(["o/a", "o/b"])).toBe(cacheKey(["o/b", "o/a"]));
  });

  test("changes when the repo set changes", () => {
    expect(cacheKey(["o/a"])).not.toBe(cacheKey(["o/a", "o/b"]));
  });
});

describe("isFresh", () => {
  test("is fresh inside the TTL and stale outside it", () => {
    const e = entry();
    expect(isFresh(e, "abc", 15, at("2026-01-01T12:14:59Z"))).toBe(true);
    expect(isFresh(e, "abc", 15, at("2026-01-01T12:15:01Z"))).toBe(false);
  });

  test("a zero TTL is never fresh", () => {
    expect(isFresh(entry(), "abc", 0, at("2026-01-01T12:00:00Z"))).toBe(false);
  });

  test("a different repo list invalidates it", () => {
    expect(isFresh(entry(), "different", 15, at("2026-01-01T12:01:00Z"))).toBe(false);
  });

  test("a partial scan is never fresh", () => {
    // Half a union rendered as if whole is the failure this prevents.
    expect(
      isFresh(entry({ partial: true }), "abc", 15, at("2026-01-01T12:01:00Z")),
    ).toBe(false);
  });

  test("a future timestamp is not fresh", () => {
    // Clock skew or a copied cache file must not pin stale data forever.
    expect(isFresh(entry(), "abc", 15, at("2026-01-01T11:00:00Z"))).toBe(false);
  });
});

describe("ageMinutes", () => {
  test("measures from fetchedAt", () => {
    expect(ageMinutes(entry(), at("2026-01-01T12:30:00Z"))).toBe(30);
  });
});

describe("cachePath", () => {
  test("honours XDG_CACHE_HOME", () => {
    expect(cachePath({ XDG_CACHE_HOME: "/xdg" } as NodeJS.ProcessEnv)).toBe(
      "/xdg/prq/scan.json",
    );
  });
});

describe("readCache", () => {
  const tmp = join(import.meta.dir, "..", "node_modules", ".prq-test-cache.json");

  test("round-trips an entry", async () => {
    await writeCache(entry({ viewer: "someone" }), tmp);
    expect((await readCache(tmp))?.viewer).toBe("someone");
    await rm(tmp, { force: true });
  });

  test("returns null for a missing file", async () => {
    expect(await readCache("/nonexistent/prq/scan.json")).toBeNull();
  });

  test("returns null for corrupt content rather than throwing", async () => {
    // A broken cache must never stop the tool starting.
    await Bun.write(tmp, "{ not json");
    expect(await readCache(tmp)).toBeNull();
    await Bun.write(tmp, JSON.stringify({ nope: true }));
    expect(await readCache(tmp)).toBeNull();
    await rm(tmp, { force: true });
  });
});

describe("cache hardening", () => {
  const tmp = join(import.meta.dir, "..", "node_modules", ".prq-test-hard.json");

  test("an entry from an older schema is never fresh", () => {
    // cacheKey hashes only the repo list, so without a version an entry whose
    // PullRequest shape predates the current model is served and throws at
    // first paint — after the renderer is up, where nothing restores the tty.
    expect(isFresh(entry({ version: 0 }), "abc", 15, at("2026-01-01T12:01:00Z"))).toBe(
      false,
    );
  });

  test("a missing partial flag is not treated as complete", () => {
    const legacy = { ...entry(), partial: undefined } as unknown as CacheEntry;
    expect(isFresh(legacy, "abc", 15, at("2026-01-01T12:01:00Z"))).toBe(false);
  });

  test("readCache rejects a wrong-version entry", async () => {
    await Bun.write(tmp, JSON.stringify({ ...entry(), version: 999 }));
    expect(await readCache(tmp)).toBeNull();
    await rm(tmp, { force: true });
  });

  test("readCache rejects a PR carrying a non-https url", async () => {
    // The cache is writable by anything in $HOME and this url reaches `open`
    // and an OSC 8 escape sequence.
    const poisoned = normalize(
      {
        id: "PR_1",
        number: 1,
        title: "t",
        url: "https://github.com/o/r/pull/1",
        isDraft: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        headRefOid: "h",
        mergeable: "MERGEABLE",
        reviewDecision: null,
        author: { login: "a" },
        repository: { nameWithOwner: "o/r" },
        viewerDidAuthor: false,
        viewerLatestReview: null,
        viewerLatestReviewRequest: null,
        latestOpinionatedReviews: { nodes: [] },
        stack: null,
        stackEntry: null,
        commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
      },
      "ermand",
    );
    await Bun.write(
      tmp,
      JSON.stringify({
        ...entry(),
        prs: [{ ...poisoned, url: "file:///Applications/Calculator.app" }],
      }),
    );
    expect(await readCache(tmp)).toBeNull();

    await Bun.write(tmp, JSON.stringify({ ...entry(), prs: [poisoned] }));
    expect((await readCache(tmp))?.prs).toHaveLength(1);
    await rm(tmp, { force: true });
  });

  test("the file is written 0600, not world-readable", async () => {
    // It is an inventory of private repo names and in-flight PR titles.
    await writeCache(entry(), tmp);
    expect(statSync(tmp).mode & 0o777).toBe(0o600);
    await rm(tmp, { force: true });
  });

  test("no temp file is left behind", async () => {
    await writeCache(entry(), tmp);
    expect(existsSync(`${tmp}.${process.pid}.tmp`)).toBe(false);
    await rm(tmp, { force: true });
  });
});
