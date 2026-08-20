/**
 * The saved project lists.
 *
 * Two keys, `github:` and `gitlab:`, so provider is **structural** rather than
 * parsed or inferred (wayfinder ticket 0022). Depth inference was ruled out by
 * evidence: `gitlab-org/gitlab` is depth 2, structurally identical to a GitHub
 * `owner/repo`.
 *
 * Validation is per-provider because the risk is. A GitHub path is interpolated
 * into a `repo:` search qualifier, so anything but `owner/name` can inject a
 * qualifier and widen the scope. A GitLab path is a bound GraphQL variable and
 * cannot alter the query, so its check is about catching typos.
 *
 * The `people:` block is a third axis, and a different kind: it maps identity
 * rather than scope. One human holds a login on each forge, and a profile that
 * splits them is wrong rather than merely incomplete — so a mistake here is
 * rejected instead of half-applied.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { identityKey, type PersonRule } from "./census";
import type { Provider } from "./domain";

export const APP_NAME = "prq";

export interface Config {
  /** Project paths per provider. A provider absent from the config has none. */
  projects: Record<Provider, string[]>;
  /**
   * Identity rules, in config order. Empty when the block is absent: every
   * unclaimed login then becomes its own person downstream, so omitting it
   * costs merging, not coverage.
   */
  people: PersonRule[];
  /**
   * Where the state database lives. Absent means the XDG default. A relative
   * path is resolved against the working directory, which is what makes
   * `statePath: state.db` keep the store beside the project.
   */
  statePath?: string;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, APP_NAME, "config.yaml");
}

export const EXAMPLE_CONFIG = `# ${APP_NAME} — projects to scan, per provider
github:
  - owner/repo
  - owner/another-repo

# GitLab paths may nest as deeply as their groups do.
# gitlab:
#   - group/subgroup/project

# One human, two forges. The driver is ermand on GitHub and ermandduro on
# GitLab, and a profile that counts them as two contributors is wrong. Each
# entry needs a label and at least one forge username. Omit the block and every
# login stands alone.
# people:
#   - label: Ermand Durro
#     github: ermand
#     gitlab: ermandduro

# Where to keep the state database. Omit for the XDG default
# (~/.local/state/${APP_NAME}/state.db). A relative path resolves against the
# directory you run ${APP_NAME} from. It holds private project names and PR
# titles, so keep it out of version control.
# statePath: .prq/state.db
`;

/**
 * Exactly `owner/name`.
 *
 * Strict because the value is interpolated into a GitHub search string: anything
 * else can inject a qualifier and silently widen what the scan covers.
 */
const GITHUB_PATH = /^[\w.-]+\/[\w.-]+$/;

/**
 * Two or more segments, no empty segment, no whitespace, no control characters.
 *
 * Looser than GitHub's because a GitLab path is passed as a GraphQL variable and
 * cannot alter query structure — this catches typos, not injection.
 */
const GITLAB_PATH = /^[\w.-]+(?:\/[\w.-]+)+$/;

export function isValidGitHubPath(path: string): boolean {
  return GITHUB_PATH.test(path);
}

export function isValidGitLabPath(path: string): boolean {
  return GITLAB_PATH.test(path);
}

const VALIDATORS: Record<Provider, (path: string) => boolean> = {
  github: isValidGitHubPath,
  gitlab: isValidGitLabPath,
};

const SHAPES: Record<Provider, string> = {
  github: "owner/name",
  gitlab: "group/project, nested as deeply as needed",
};

function readList(
  doc: Record<string, unknown>,
  provider: Provider,
): string[] {
  const raw = doc[provider];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`\`${provider}\` must be a list of project paths`);
  }
  const invalid = raw.filter(
    (p) => typeof p !== "string" || !VALIDATORS[provider](p),
  );
  if (invalid.length > 0) {
    throw new Error(
      `\`${provider}\` entries must be ${SHAPES[provider]} — rejected: ` +
        invalid.map((p) => JSON.stringify(p)).join(", "),
    );
  }
  return [...new Set(raw as string[])];
}

/**
 * A forge username, not a project path.
 *
 * Deliberately not `isValidGitHubPath`: that accepts `owner/repo`, so validating
 * an alias as a path would let a project path pose as a person and claim nobody.
 * A username carries no separator and no whitespace.
 */
const USERNAME = /^[\w.-]+$/;

/** Everything an entry may say. Anything else is a typo that would drop an alias. */
const PERSON_KEYS: Record<string, true> = { label: true, github: true, gitlab: true };

const PROVIDERS: readonly Provider[] = ["github", "gitlab"];

/**
 * Reads the `people:` block. Absent or empty yields no rules, which is a working
 * config; anything present but malformed throws, because the failure mode of a
 * dropped alias is a profile that is confidently half-right.
 */
function readPeople(doc: Record<string, unknown>): PersonRule[] {
  const raw = doc.people;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      "`people` must be a list of entries, each with a `label` and at least one " +
        "of `github:` or `gitlab:`",
    );
  }

  const rules: PersonRule[] = [];
  // identity -> claiming label. Two entries claiming one account would corrupt
  // both profiles, so the collision is fatal rather than last-write-wins.
  const claimed = new Map<string, string>();

  for (const [index, entry] of raw.entries()) {
    const at = `\`people\` entry ${index + 1}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${at} must be a mapping — rejected: ${JSON.stringify(entry)}`);
    }
    const row = entry as Record<string, unknown>;

    const label = typeof row.label === "string" ? row.label.trim() : "";
    if (label === "") {
      throw new Error(
        `${at} needs a non-empty \`label\` — rejected: ${JSON.stringify(row.label ?? null)}`,
      );
    }
    const named = `\`people\` entry \`${label}\``;

    const unknown = Object.keys(row).filter((key) => PERSON_KEYS[key] !== true);
    if (unknown.length > 0) {
      throw new Error(
        `${named} has unknown ${unknown.length === 1 ? "key" : "keys"} ` +
          `${unknown.map((key) => JSON.stringify(key)).join(", ")} — an entry takes ` +
          "`label`, `github` and `gitlab` only",
      );
    }

    const aliases: { provider: Provider; username: string }[] = [];
    for (const provider of PROVIDERS) {
      const value = row[provider];
      if (value === undefined || value === null) continue;
      // Not trimmed. A padded login is a mistake worth naming, and quietly
      // fixing it would hide the one case that matters: a value that is not a
      // login at all.
      const username = typeof value === "string" ? value : "";
      if (!USERNAME.test(username)) {
        throw new Error(
          `${named} needs a \`${provider}\` username — one forge login, no \`/\` ` +
            "and no whitespace — rejected: " +
            JSON.stringify(value),
        );
      }
      const key = identityKey(provider, username);
      const prior = claimed.get(key);
      if (prior !== undefined) {
        throw new Error(
          `\`${provider}: ${username}\` is claimed by two \`people\` entries, ` +
            `\`${prior}\` and \`${label}\` — one forge account belongs to one human`,
        );
      }
      claimed.set(key, label);
      aliases.push({ provider, username });
    }

    if (aliases.length === 0) {
      throw new Error(
        `${named} claims nobody — give it a \`github\` or \`gitlab\` username`,
      );
    }

    rules.push({ label, aliases });
  }

  return rules;
}

/**
 * Parses config text. Throws on anything malformed rather than silently scanning
 * a subset — a dashboard that quietly drops a project is worse than one that
 * refuses to start.
 */
export function parseConfig(text: string): Config {
  const doc: unknown = parse(text);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("config must be a YAML mapping with a `github:` or `gitlab:` key");
  }
  const mapping = doc as Record<string, unknown>;

  if (mapping.repos !== undefined) {
    // Retired loudly rather than aliased to GitHub. An ignored key that no longer
    // does anything is harmless; one that still looks load-bearing is not.
    throw new Error(
      "`repos:` is no longer supported — list projects under `github:` and " +
        "`gitlab:` instead, so each provider is explicit",
    );
  }

  const projects: Record<Provider, string[]> = {
    github: readList(mapping, "github"),
    gitlab: readList(mapping, "gitlab"),
  };

  if (projects.github.length === 0 && projects.gitlab.length === 0) {
    throw new Error("no projects configured — add at least one under `github:` or `gitlab:`");
  }

  const { statePath } = mapping;
  if (statePath !== undefined && (typeof statePath !== "string" || statePath.trim() === "")) {
    throw new Error("`statePath` must be a non-empty string");
  }

  return {
    projects,
    people: readPeople(mapping),
    ...(statePath === undefined ? {} : { statePath: (statePath as string).trim() }),
  };
}

export async function loadConfig(path = configPath()): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`no config at ${path}\n\nCreate one:\n\n${EXAMPLE_CONFIG}`);
  }
  try {
    return parseConfig(await file.text());
  } catch (cause) {
    throw new Error(`${path}: ${(cause as Error).message}`, { cause });
  }
}
