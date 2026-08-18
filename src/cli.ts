#!/usr/bin/env bun
/**
 * Entry point.
 *
 * Launch reads the store and touches no network. Syncing is an explicit act —
 * a key in the TUI, or `prq sync` — so a diff can never be destroyed by a
 * refresh the driver did not ask for.
 *
 * Sync semantics are wayfinder ticket 0016, still open; the launch behaviour and
 * first-run wording here are prototype choices.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { diff, type Change } from "./changes";
import { configPath, EXAMPLE_CONFIG, loadConfig } from "./config";
import type { PullRequest } from "./domain";
import { githubToken, scan } from "./github";
import { resolveStorePath, Store, storePath, type SyncRecord } from "./store";
import { runApp } from "./tui";

export interface SyncOutcome {
  /** Null when the scan was partial, so nothing was committed. */
  sync: SyncRecord | null;
  prs: PullRequest[];
  changes: Change[];
  failures: string[];
  baselineReset: boolean;
  /** Wall-clock time the shown data describes. */
  at: Date;
  viewer: string;
}

/**
 * Fetches, diffs against the stored state, and commits — but only when the scan
 * was whole. A partial result committed as a baseline makes every later diff
 * inherit the hole, so a partial scan is shown and discarded.
 */
export async function performSync(
  store: Store,
  repos: string[],
  signal?: AbortSignal,
): Promise<SyncOutcome> {
  const result = await scan(repos, await githubToken(), signal);
  const previous = store.read();

  // No comparable baseline. `prs.length !== sync.prCount` catches both a schema
  // drop and rows rejected on read — comparing against a partial baseline would
  // fabricate a `left` for every missing PR and then a `joined` the sync after.
  // A previous sync that legitimately stored zero PRs is NOT a reset: otherwise
  // the first PR ever to appear would be swallowed and never reported.
  const baselineReset =
    previous.sync === null ||
    previous.incomplete ||
    previous.prs.length !== previous.sync.prCount;

  if (result.failures.length > 0) {
    // Not committed, and deliberately reporting no changes: a scan that could
    // not see the whole set cannot say what left it. The union is two searches,
    // so one failing half would make every PR it alone returns look departed.
    return {
      sync: null,
      prs: result.prs,
      changes: [],
      failures: result.failures,
      baselineReset: previous.sync?.baselineReset ?? baselineReset,
      // The baseline is unchanged, so the age shown must stay the old one rather
      // than reading "just now" over hours-old data.
      at: previous.sync === null ? new Date() : new Date(previous.sync.at),
      viewer: result.viewer || previous.sync?.viewer || "",
    };
  }

  const changes = baselineReset ? [] : diff(previous.prs, result.prs);
  const sync = store.commit({
    viewer: result.viewer,
    repos,
    prs: result.prs,
    changes,
    baselineReset,
  });
  return {
    sync,
    prs: result.prs,
    changes,
    failures: [],
    baselineReset,
    at: new Date(sync.at),
    viewer: sync.viewer,
  };
}

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

  const flagIndex = args.indexOf("--state");
  const override = flagIndex === -1 ? undefined : args[flagIndex + 1];
  if (flagIndex !== -1 && (override === undefined || override.startsWith("-"))) {
    throw new Error("--state needs a path");
  }

  if (args.includes("--help") || args.includes("-h")) {
    // Reports the path actually in force, not the default — otherwise a
    // configured store is invisible in the one place people look for it.
    let effective = storePath();
    try {
      const { statePath } = await loadConfig();
      effective = resolveStorePath(override ?? statePath);
    } catch {
      // No config yet; the default is the honest answer.
    }
    process.stdout.write(
      "prq — open pull requests that concern you\n\n" +
        "  prq            open the dashboard on the last synced state\n" +
        "  prq sync       sync now, then report what changed\n" +
        "  prq init       write an example config\n" +
        "  --state <path> use this state database instead of the configured one\n" +
        `\nconfig: ${configPath()}\nstate:  ${effective}\n`,
    );
    return;
  }

  if (args[0] === "init") {
    await initConfig();
    return;
  }

  const config = await loadConfig();
  // A flag beats the config, which beats the XDG default.
  const dbPath = resolveStorePath(override ?? config.statePath);
  const store = await Store.open(dbPath);

  // Every path out of here must close the store, or the WAL sidecars outlive
  // the process still carrying a copy of the data.
  try {
    if (args[0] === "sync") {
      const outcome = await performSync(store, config.repos);
      for (const failure of outcome.failures) {
        process.stderr.write(`INCOMPLETE — ${failure}\n`);
      }
      process.stdout.write(
        `${outcome.failures.length > 0 ? "not committed" : "synced"}: ` +
          `${outcome.prs.length} PRs, ${outcome.changes.length} change(s)` +
          `${outcome.baselineReset && outcome.failures.length === 0 ? " (baseline set)" : ""}\n`,
      );
      if (outcome.failures.length > 0) throw new SilentFailure();
      return;
    }

    const state = store.read();
    if (state.incomplete) {
      process.stderr.write(
        "stored state was unreadable in part — the next sync will reset the baseline\n",
      );
    }
    await runApp({
      prs: state.prs,
      changes: state.changes,
      viewer: state.sync?.viewer ?? "",
      repos: config.repos,
      lastSync: state.sync === null ? null : new Date(state.sync.at),
      baselineReset: state.sync?.baselineReset ?? false,
      sync: async (signal: AbortSignal) => {
        const outcome = await performSync(store, config.repos, signal);
        return {
          prs: outcome.prs,
          changes: outcome.changes,
          failures: outcome.failures,
          at: outcome.at,
          viewer: outcome.viewer,
          baselineReset: outcome.baselineReset,
        };
      },
    });
  } finally {
    store.close();
  }
}

/** Exits non-zero without printing again — the message is already out. */
class SilentFailure extends Error {}

main().catch((error: unknown) => {
  if (error instanceof SilentFailure) process.exit(1);
  const wrapped = error as { message?: string; cause?: { message?: string } };
  process.stderr.write(`${wrapped?.message ?? String(error)}\n`);
  // loadConfig wraps the YAML parser's error, which carries the line and
  // column; without this the useful half is discarded.
  if (wrapped?.cause?.message) {
    process.stderr.write(`  cause: ${wrapped.cause.message}\n`);
  }
  process.exit(1);
});
