import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { configPath, EXAMPLE_CONFIG, loadConfig, parseConfig } from "./config";

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
  test("reads a repo list", () => {
    expect(parseConfig("repos:\n  - o/a\n  - o/b\n").repos).toEqual(["o/a", "o/b"]);
  });

  test("ignores a TTL that older configs may still carry", () => {
    // The TTL was removed when sync became explicit; an old config must not
    // start failing because of a key that no longer means anything.
    expect(parseConfig("repos: [o/a]\ncacheTtlMinutes: 15").repos).toEqual(["o/a"]);
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

describe("statePath", () => {
  test("is absent by default", () => {
    expect(parseConfig("repos: [o/a]").statePath).toBeUndefined();
  });

  test("is carried through, trimmed", () => {
    expect(parseConfig("repos: [o/a]\nstatePath: .prq/state.db").statePath).toBe(
      ".prq/state.db",
    );
    expect(parseConfig('repos: [o/a]\nstatePath: "  ./state.db  "').statePath).toBe(
      "./state.db",
    );
  });

  test("rejects a blank or non-string value", () => {
    // An empty path would resolve to the working directory itself.
    expect(() => parseConfig('repos: [o/a]\nstatePath: ""')).toThrow(/non-empty string/);
    expect(() => parseConfig('repos: [o/a]\nstatePath: "   "')).toThrow(/non-empty string/);
    expect(() => parseConfig("repos: [o/a]\nstatePath: 42")).toThrow(/non-empty string/);
  });
});
