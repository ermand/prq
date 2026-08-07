/**
 * Scan cache.
 *
 * Ticket 0009 is still open. The driver's direction is a 15-minute TTL, so that
 * is what this implements — but note the scan measured at roughly 0.8s, so the
 * cache buys instant first paint rather than hiding latency.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chmod, mkdir, rename } from "node:fs/promises";
import { APP_NAME } from "./config";
import { isPullRequest, type PullRequest } from "./domain";

/**
 * Bumped whenever `PullRequest` changes shape. `cacheKey` only hashes the repo
 * list, so without this an entry written by older code is served as fresh and
 * throws during first paint — after the renderer is up, where nothing restores
 * the terminal.
 */
export const CACHE_VERSION = 1;

export interface CacheEntry {
  version: number;
  /** Identifies the repo list the scan covered; a change invalidates it. */
  key: string;
  fetchedAt: string;
  viewer: string;
  prs: PullRequest[];
  /** True when the scan it came from was missing one of its two queries. */
  partial: boolean;
  /** Why the scan was partial, if it was. */
  failures: string[];
}

export function cachePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, APP_NAME, "scan.json");
}

export function cacheKey(repos: string[]): string {
  return createHash("sha256")
    .update([...repos].sort().join("\n"))
    .digest("hex")
    .slice(0, 16);
}

export function ageMinutes(entry: CacheEntry, now = new Date()): number {
  return (now.getTime() - new Date(entry.fetchedAt).getTime()) / 60_000;
}

export function isFresh(
  entry: CacheEntry,
  key: string,
  ttlMinutes: number,
  now = new Date(),
): boolean {
  if (entry.version !== CACHE_VERSION) return false;
  if (entry.key !== key) return false;
  // A partial scan is never allowed to satisfy a read; it would silently
  // present an incomplete union as if it were whole.
  if (entry.partial !== false) return false;
  const age = ageMinutes(entry, now);
  return age >= 0 && age < ttlMinutes;
}

/**
 * Returns null rather than throwing: a corrupt cache must not stop the tool.
 *
 * The file is untrusted input — any process able to write one file in $HOME can
 * reach it, and a PR's `url` from here goes on to be spawned via `open` and
 * embedded in an OSC 8 escape sequence. Every record is validated.
 */
export async function readCache(path = cachePath()): Promise<CacheEntry | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const parsed: unknown = await file.json();
    if (parsed === null || typeof parsed !== "object") return null;
    const entry = parsed as Record<string, unknown>;
    if (
      entry.version !== CACHE_VERSION ||
      typeof entry.key !== "string" ||
      typeof entry.fetchedAt !== "string" ||
      typeof entry.viewer !== "string" ||
      typeof entry.partial !== "boolean" ||
      !Array.isArray(entry.failures) ||
      !entry.failures.every((f) => typeof f === "string") ||
      !Array.isArray(entry.prs) ||
      !entry.prs.every(isPullRequest)
    ) {
      return null;
    }
    return entry as unknown as CacheEntry;
  } catch {
    return null;
  }
}

/**
 * Written 0600 via a temp file and a rename: the contents are an inventory of
 * private repo names and in-flight PR titles, and a torn write must never be
 * readable as a whole entry.
 */
export async function writeCache(
  entry: CacheEntry,
  path = cachePath(),
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode does not apply to a directory that already exists.
  await chmod(dir, 0o700);
  const temp = `${path}.${process.pid}.tmp`;
  await Bun.write(temp, JSON.stringify(entry));
  await chmod(temp, 0o600);
  await rename(temp, path);
}
