import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  configPath,
  DEFAULT_TTL_MINUTES,
  EXAMPLE_CONFIG,
  loadConfig,
  parseConfig,
} from "./config";

describe("configPath", () => {
  test("honours XDG_CONFIG_HOME", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/xdg" } as NodeJS.ProcessEnv)).toBe(
      "/xdg/prq/config.yaml",
    );
  });

  test("falls back to ~/.config", () => {
    expect(configPath({} as NodeJS.ProcessEnv)).toEndWith(
      join(".config", "prq", "config.yaml"),
    );
  });
});

describe("parseConfig", () => {
  test("reads a repo list and defaults the TTL", () => {
    const c = parseConfig("repos:\n  - o/a\n  - o/b\n");
    expect(c.repos).toEqual(["o/a", "o/b"]);
    expect(c.cacheTtlMinutes).toBe(DEFAULT_TTL_MINUTES);
  });

  test("honours an explicit TTL, including zero", () => {
    expect(parseConfig("repos: [o/a]\ncacheTtlMinutes: 0").cacheTtlMinutes).toBe(0);
    expect(parseConfig("repos: [o/a]\ncacheTtlMinutes: 60").cacheTtlMinutes).toBe(60);
  });

  test("deduplicates repeated repos", () => {
    expect(parseConfig("repos: [o/a, o/b, o/a]").repos).toEqual(["o/a", "o/b"]);
  });

  test("rejects an entry that is not owner/name", () => {
    // A bare name or a URL would silently widen or break the search scope.
    expect(() => parseConfig("repos: [cli]")).toThrow(/owner\/name/);
    expect(() => parseConfig("repos: ['https://github.com/o/a']")).toThrow(
      /owner\/name/,
    );
  });

  test("rejects a repo entry carrying extra search qualifiers", () => {
    // Injection into the search scope.
    expect(() => parseConfig("repos: ['o/a is:private']")).toThrow(/owner\/name/);
  });

  test("rejects an empty or missing repo list", () => {
    expect(() => parseConfig("repos: []")).toThrow(/non-empty/);
    expect(() => parseConfig("cacheTtlMinutes: 5")).toThrow(/non-empty/);
  });

  test("rejects a non-mapping document", () => {
    expect(() => parseConfig("- o/a")).toThrow(/YAML mapping/);
    expect(() => parseConfig("")).toThrow(/YAML mapping/);
  });

  test("rejects a nonsense TTL", () => {
    expect(() => parseConfig("repos: [o/a]\ncacheTtlMinutes: -1")).toThrow(/non-negative/);
    expect(() => parseConfig("repos: [o/a]\ncacheTtlMinutes: soon")).toThrow(
      /non-negative/,
    );
  });

  test("the shipped example parses", () => {
    // Guards against the onboarding text drifting from the parser.
    expect(parseConfig(EXAMPLE_CONFIG).repos).toEqual([
      "owner/repo",
      "owner/another-repo",
    ]);
  });
});

describe("loadConfig", () => {
  test("explains itself when there is no config", async () => {
    await expect(loadConfig("/nonexistent/prq/config.yaml")).rejects.toThrow(
      /no config at/,
    );
  });

  test("names the file when its contents are bad", async () => {
    const path = join(import.meta.dir, "..", "node_modules", ".prq-test-bad.yaml");
    await Bun.write(path, "repos: []");
    await expect(loadConfig(path)).rejects.toThrow(/\.prq-test-bad\.yaml: /);
  });
});
