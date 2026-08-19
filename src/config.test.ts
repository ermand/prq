import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  configPath,
  EXAMPLE_CONFIG,
  isValidGitHubPath,
  isValidGitLabPath,
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

describe("two lists", () => {
  test("reads each provider separately", () => {
    const c = parseConfig("github:\n  - o/a\ngitlab:\n  - g/s/p\n");
    expect(c.projects.github).toEqual(["o/a"]);
    expect(c.projects.gitlab).toEqual(["g/s/p"]);
  });

  test("a provider absent from the config has no projects", () => {
    expect(parseConfig("github: [o/a]").projects.gitlab).toEqual([]);
    expect(parseConfig("gitlab: [g/s/p]").projects.github).toEqual([]);
  });

  test("deduplicates within a list", () => {
    expect(parseConfig("github: [o/a, o/b, o/a]").projects.github).toEqual(["o/a", "o/b"]);
  });

  test("rejects a config with no projects at all", () => {
    expect(() => parseConfig("statePath: x.db")).toThrow(/no projects configured/);
    expect(() => parseConfig("github: []\ngitlab: []")).toThrow(/no projects configured/);
  });

  test("rejects a list that is not a list", () => {
    expect(() => parseConfig("github: nope")).toThrow(/must be a list/);
  });

  test("retires `repos:` loudly rather than assuming GitHub", () => {
    // An ignored key that no longer does anything is harmless; one that still
    // looks load-bearing is not.
    expect(() => parseConfig("repos: [o/a]")).toThrow(/no longer supported/);
    expect(() => parseConfig("repos: [o/a]")).toThrow(/github:/);
  });

  test("the shipped example parses", () => {
    expect(parseConfig(EXAMPLE_CONFIG).projects.github).toEqual([
      "owner/repo",
      "owner/another-repo",
    ]);
  });
});

describe("per-provider path validation", () => {
  test("GitHub stays exactly owner/name", () => {
    // Its path is interpolated into a `repo:` search qualifier, so anything else
    // can inject a qualifier and silently widen the scope.
    expect(isValidGitHubPath("cli/cli")).toBe(true);
    expect(isValidGitHubPath("group/sub/project")).toBe(false);
    expect(isValidGitHubPath("cli")).toBe(false);
    expect(isValidGitHubPath("o/a is:private")).toBe(false);
  });

  test("GitLab accepts nested groups", () => {
    expect(isValidGitLabPath("gitlab-org/gitlab")).toBe(true);
    expect(isValidGitLabPath("albanian-technology-distribution/kesh/kesh-back")).toBe(true);
    expect(isValidGitLabPath("a/b/c/d/e")).toBe(true);
  });

  test("GitLab still rejects nonsense", () => {
    expect(isValidGitLabPath("nogroup")).toBe(false);
    expect(isValidGitLabPath("/leading")).toBe(false);
    expect(isValidGitLabPath("trailing/")).toBe(false);
    expect(isValidGitLabPath("a//b")).toBe(false);
    expect(isValidGitLabPath("a/b c")).toBe(false);
    expect(isValidGitLabPath("a/b\u0007c")).toBe(false);
  });

  test("a GitHub list rejects a GitLab-shaped path", () => {
    // The whole reason validation is per-provider rather than one loose pattern.
    expect(() => parseConfig("github: [group/sub/project]")).toThrow(/owner\/name/);
  });

  test("a GitLab list accepts what GitHub's would reject", () => {
    expect(parseConfig("gitlab: [group/sub/project]").projects.gitlab).toEqual([
      "group/sub/project",
    ]);
  });

  test("names the offending entries", () => {
    expect(() => parseConfig("github: [ok/one, bad]")).toThrow(/"bad"/);
  });
});

describe("statePath", () => {
  test("is absent by default", () => {
    expect(parseConfig("github: [o/a]").statePath).toBeUndefined();
  });

  test("is carried through, trimmed", () => {
    expect(parseConfig("github: [o/a]\nstatePath: .prq/state.db").statePath).toBe(
      ".prq/state.db",
    );
  });

  test("rejects a blank or non-string value", () => {
    expect(() => parseConfig('github: [o/a]\nstatePath: ""')).toThrow(/non-empty string/);
    expect(() => parseConfig("github: [o/a]\nstatePath: 42")).toThrow(/non-empty string/);
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
    await Bun.write(path, "github: []");
    await expect(loadConfig(path)).rejects.toThrow(/\.prq-test-bad\.yaml: /);
  });
});
