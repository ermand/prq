/**
 * The saved repository list.
 *
 * Ticket 0004 is still open — this implements the driver's YAML direction with
 * the smallest schema that works. Grouping, per-repo flags and in-TUI editing
 * are deliberately absent until that ticket resolves.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { isValidRepo } from "./query";

export const APP_NAME = "prq";

export interface Config {
  repos: string[];
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, APP_NAME, "config.yaml");
}

export const EXAMPLE_CONFIG = `# ${APP_NAME} — repositories to scan
repos:
  - owner/repo
  - owner/another-repo
`;

/**
 * Parses config text. Throws on anything malformed rather than silently
 * scanning a subset — a dashboard that quietly drops a repo is worse than one
 * that refuses to start.
 */
export function parseConfig(text: string): Config {
  const doc: unknown = parse(text);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("config must be a YAML mapping with a `repos:` key");
  }

  const { repos } = doc as Record<string, unknown>;

  if (!Array.isArray(repos) || repos.length === 0) {
    throw new Error("`repos` must be a non-empty list of owner/name entries");
  }

  const invalid = repos.filter((r) => typeof r !== "string" || !isValidRepo(r));
  if (invalid.length > 0) {
    throw new Error(
      `not owner/name: ${invalid.map((r) => JSON.stringify(r)).join(", ")}`,
    );
  }

  // A TTL used to live here. Sync is now an explicit act, so there is nothing
  // to expire: the store holds the last synced state until the driver asks for
  // another one.
  return { repos: [...new Set(repos as string[])] };
}

export async function loadConfig(path = configPath()): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(
      `no config at ${path}\n\nCreate one:\n\n${EXAMPLE_CONFIG}`,
    );
  }
  try {
    return parseConfig(await file.text());
  } catch (cause) {
    throw new Error(`${path}: ${(cause as Error).message}`, { cause });
  }
}
