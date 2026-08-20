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

  test("accepts a config with no projects at all", () => {
    // Projects moved into the database, so a file holding only `statePath` — what
    // `prq init` now writes — is the normal shape rather than an error.
    expect(parseConfig("statePath: x.db").projects).toEqual({ github: [], gitlab: [] });
    expect(parseConfig("github: []\ngitlab: []").projects).toEqual({ github: [], gitlab: [] });
  });

  test("an empty or all-comments file means defaults", () => {
    // YAML parses both to null. `prq init` writes an all-comments file, so this
    // path is the one a new user hits first.
    for (const text of ["", "\n\n", "# just a comment\n"]) {
      expect(parseConfig(text)).toEqual({ projects: { github: [], gitlab: [] }, people: [] });
    }
  });

  test("still refuses a value that is not a mapping", () => {
    expect(() => parseConfig("- owner/repo")).toThrow(/must be a YAML mapping/);
    expect(() => parseConfig("just a string")).toThrow(/must be a YAML mapping/);
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

  test("the shipped example parses, and configures nothing", () => {
    // Everything in it is commented out now: `prq init` writes a file whose only
    // job is to document `statePath`. Projects and people come from the database.
    expect(parseConfig(EXAMPLE_CONFIG)).toEqual({
      projects: { github: [], gitlab: [] },
      people: [],
    });
  });

  test("the shipped example's commented seed keys are valid once uncommented", () => {
    // Sliced from the `# github:` line rather than pattern-matched, because the
    // prose above it contains the word "people" at the start of a line and a
    // looser rule uncommented that too.
    const lines = EXAMPLE_CONFIG.split("\n");
    const start = lines.findIndex((line) => line.startsWith("# github:"));
    const uncommented = lines
      .slice(start)
      .map((line) => (line.startsWith("# ") ? line.slice(2) : line))
      .join("\n");
    const parsed = parseConfig(uncommented);
    expect(parsed.projects.github).toEqual(["owner/repo"]);
    expect(parsed.projects.gitlab).toEqual(["group/subgroup/project"]);
    expect(parsed.people).toEqual([
      {
        label: "Ermand Durro",
        aliases: [
          { provider: "github", username: "ermand" },
          { provider: "gitlab", username: "ermandduro" },
        ],
      },
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
    // `github: []` used to be rejected for having no projects and is now valid,
    // so this needs content that is still a real mistake: a sequence, not a
    // mapping.
    await Bun.write(path, "- owner/repo\n");
    await expect(loadConfig(path)).rejects.toThrow(/\.prq-test-bad\.yaml: /);
  });
});

describe("people", () => {
  const base = "github: [o/a]\n";

  const block = (...lines: string[]) => `${base}people:\n${lines.join("\n")}\n`;

  test("is empty when the block is absent", () => {
    expect(parseConfig(base).people).toEqual([]);
  });

  test("is empty when the block is present but empty", () => {
    expect(parseConfig(`${base}people: []`).people).toEqual([]);
  });

  test("the shipped example leaves it commented out", () => {
    expect(parseConfig(EXAMPLE_CONFIG).people).toEqual([]);
  });

  test("merges one human's two forge logins, github first", () => {
    // The driver is `ermand` on GitHub and `ermandduro` on GitLab; a profile
    // that splits them is wrong rather than merely incomplete.
    const c = parseConfig(
      block("  - label: Ermand Durro", "    github: ermand", "    gitlab: ermandduro"),
    );
    expect(c.people).toEqual([
      {
        label: "Ermand Durro",
        aliases: [
          { provider: "github", username: "ermand" },
          { provider: "gitlab", username: "ermandduro" },
        ],
      },
    ]);
  });

  test("a one-forge entry parses — most people hold a single login", () => {
    expect(parseConfig(block("  - label: A", "    github: a")).people).toEqual([
      { label: "A", aliases: [{ provider: "github", username: "a" }] },
    ]);
    expect(parseConfig(block("  - label: B", "    gitlab: b")).people).toEqual([
      { label: "B", aliases: [{ provider: "gitlab", username: "b" }] },
    ]);
  });

  test("rejects an entry that claims nobody", () => {
    expect(() => parseConfig(block("  - label: Nobody"))).toThrow(
      /`Nobody` claims nobody/,
    );
  });

  test("rejects a missing, empty or whitespace label", () => {
    expect(() => parseConfig(block("  - github: a"))).toThrow(
      /entry 1 needs a non-empty `label` — rejected: null/,
    );
    expect(() => parseConfig(block('  - label: ""', "    github: a"))).toThrow(
      /needs a non-empty `label` — rejected: ""/,
    );
    expect(() => parseConfig(block('  - label: "   "', "    github: a"))).toThrow(
      /needs a non-empty `label` — rejected: "   "/,
    );
  });

  test("rejects a project path where a username belongs", () => {
    // `isValidGitHubPath` would accept this, which is why it is the wrong check.
    const bad = block("  - label: A", "    github: owner/repo");
    expect(() => parseConfig(bad)).toThrow(/`A` needs a `github` username/);
    expect(() => parseConfig(bad)).toThrow(/rejected: "owner\/repo"/);
  });

  test("rejects whitespace inside or around a username", () => {
    expect(() => parseConfig(block("  - label: A", '    gitlab: "two words"'))).toThrow(
      /`A` needs a `gitlab` username[\s\S]*rejected: "two words"/,
    );
    expect(() => parseConfig(block("  - label: A", '    github: " ermand "'))).toThrow(
      /rejected: " ermand "/,
    );
  });

  test("rejects a non-string username", () => {
    expect(() => parseConfig(block("  - label: A", "    github: 42"))).toThrow(
      /`A` needs a `github` username[\s\S]*rejected: 42/,
    );
  });

  test("rejects an unknown key rather than dropping the alias it meant", () => {
    expect(() =>
      parseConfig(block("  - label: A", "    github: a", "    gitlabb: b")),
    ).toThrow(/`A` has unknown key "gitlabb"/);
  });

  test("rejects one account claimed by two entries", () => {
    // Silently merging them would corrupt both profiles.
    expect(() =>
      parseConfig(
        block("  - label: A", "    github: shared", "  - label: B", "    github: shared"),
      ),
    ).toThrow(/`github: shared` is claimed by two `people` entries, `A` and `B`/);
  });

  test("rejects a block that is not a list", () => {
    expect(() => parseConfig(`${base}people: ermand`)).toThrow(/`people` must be a list/);
  });

  test("rejects an entry that is not a mapping", () => {
    expect(() => parseConfig(block("  - ermand"))).toThrow(
      /entry 1 must be a mapping — rejected: "ermand"/,
    );
  });
});
