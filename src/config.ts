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
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { Provider } from "./domain";

export const APP_NAME = "prq";

export interface Config {
  /** Project paths per provider. A provider absent from the config has none. */
  projects: Record<Provider, string[]>;
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
