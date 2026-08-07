#!/usr/bin/env bun
/**
 * Entry point. Loads config, serves a fresh-enough cache or scans, then hands
 * off to the TUI.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CACHE_VERSION,
  cacheKey,
  cachePath,
  isFresh,
  readCache,
  writeCache,
  type CacheEntry,
} from "./cache";
import { configPath, EXAMPLE_CONFIG, loadConfig } from "./config";
import { githubToken, scan } from "./github";
import { runApp } from "./tui";

async function initConfig(): Promise<void> {
  const path = configPath();
  if (await Bun.file(path).exists()) {
    process.stdout.write(`config already exists: ${path}\n`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, EXAMPLE_CONFIG);
  process.stdout.write(`wrote ${path}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "prq — open pull requests that concern you\n\n" +
        "  prq            open the dashboard\n" +
        "  prq init       write an example config\n" +
        "  prq --no-cache force a fresh scan\n" +
        `\nconfig: ${configPath()}\n`,
    );
    return;
  }

  if (args[0] === "init") {
    await initConfig();
    return;
  }

  const config = await loadConfig();
  const key = cacheKey(config.repos);
  const path = cachePath();
  const noCache = args.includes("--no-cache");

  const cached = noCache ? null : await readCache(path);
  const usable =
    cached && isFresh(cached, key, config.cacheTtlMinutes) ? cached : null;

  const runScan = async (signal?: AbortSignal) => {
    const result = await scan(config.repos, await githubToken(), signal);
    const entry: CacheEntry = {
      version: CACHE_VERSION,
      key,
      fetchedAt: new Date().toISOString(),
      viewer: result.viewer,
      prs: result.prs,
      partial: result.failures.length > 0,
      failures: result.failures,
    };
    await writeCache(entry, path);
    return {
      prs: result.prs,
      partial: entry.partial,
      failures: result.failures,
      fetchedAt: new Date(entry.fetchedAt),
      viewer: result.viewer,
    };
  };

  const initial = usable
    ? {
        prs: usable.prs,
        partial: usable.partial,
        failures: usable.failures,
        fetchedAt: new Date(usable.fetchedAt),
        viewer: usable.viewer,
      }
    : await runScan();

  await runApp({
    prs: initial.prs,
    viewer: initial.viewer,
    repos: config.repos,
    fetchedAt: initial.fetchedAt,
    partial: initial.partial,
    failures: initial.failures,
    refresh: async (signal: AbortSignal) => {
      const next = await runScan(signal);
      return {
        prs: next.prs,
        partial: next.partial,
        failures: next.failures,
        fetchedAt: next.fetchedAt,
      };
    },
  });
}

main().catch((error: unknown) => {
  const wrapped = error as { message?: string; cause?: { message?: string } };
  process.stderr.write(`${wrapped?.message ?? String(error)}\n`);
  // loadConfig wraps the YAML parser's error, which carries the line and
  // column; without this the useful half is discarded.
  if (wrapped?.cause?.message) {
    process.stderr.write(`  cause: ${wrapped.cause.message}\n`);
  }
  process.exit(1);
});
