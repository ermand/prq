#!/usr/bin/env bun
/**
 * Entry point.
 *
 * Launch reads the store and touches no network. Syncing is an explicit act — a
 * key in the TUI, or `prq sync` — so a diff can never be destroyed by a refresh
 * the driver did not ask for.
 *
 * Providers sync **independently**: each commits its own baseline, so one being
 * unreachable freezes only its own diff. Sync semantics are wayfinder ticket 0016,
 * still open; the launch behaviour and wording here are prototype choices.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { diff, type Change } from "./changes";
import { configPath, EXAMPLE_CONFIG, loadConfig } from "./config";
import { sanitize, type Provider, type PullRequest } from "./domain";
import { github } from "./github";
import { gitlab } from "./gitlab";
import type { ProviderClient } from "./providers";
import { resolveStorePath, Store, storePath, type SyncRecord } from "./store";
import { runApp } from "./tui";

const CLIENTS: Record<Provider, ProviderClient> = { github, gitlab };
export const PROVIDER_ORDER: Provider[] = ["github", "gitlab"];

export interface ProviderOutcome {
  provider: Provider;
  /** Null when the scan was partial, so nothing was committed. */
  sync: SyncRecord | null;
  prs: PullRequest[];
  changes: Change[];
  failures: string[];
  baselineReset: boolean;
  /** Wall-clock time the shown rows describe. */
  at: Date | null;
  viewer: string;
}

export interface SyncOutcome {
  byProvider: ProviderOutcome[];
  prs: PullRequest[];
  changes: Change[];
  failures: string[];
}

/**
 * Fetches one provider, diffs against its stored state, and commits — but only
 * when its scan was whole. A partial result committed as a baseline makes every
 * later diff inherit the hole, so a partial scan is shown and discarded.
 */
export async function syncProvider(
  store: Store,
  provider: Provider,
  projects: string[],
  signal?: AbortSignal,
): Promise<ProviderOutcome> {
  const previous = store.read(provider);
  const empty: ProviderOutcome = {
    provider,
    sync: previous.sync,
    prs: previous.prs,
    changes: previous.changes,
    failures: [],
    baselineReset: previous.sync?.baselineReset ?? false,
    at: previous.sync === null ? null : new Date(previous.sync.at),
    viewer: previous.sync?.viewer ?? "",
  };
  // A provider with no configured projects is not scanned and not failed. Its
  // previously stored rows, if any, are left exactly as they were.
  if (projects.length === 0) return empty;

  const client = CLIENTS[provider];
  const result = await client.scan(projects, await client.token(), signal);

  // No comparable baseline. `prs.length !== sync.prCount` catches both a schema
  // drop and rows rejected on read — diffing against a short baseline would
  // fabricate a `left` for every missing row and a `joined` the sync after. A
  // previous sync that legitimately stored zero rows is NOT a reset.
  const baselineReset =
    previous.sync === null ||
    previous.incomplete ||
    previous.prs.length !== previous.sync.prCount;

  if (result.failed.length > 0) {
    // Not committed, and the previous rows stay on screen: a scan that could not
    // see the whole set cannot say what left it, and showing only the half it did
    // see would read as "everything else was merged". `changes` is cleared rather
    // than carried, because the stored changes describe the previous row set and
    // could otherwise reference a PR absent from the list.
    return {
      ...empty,
      changes: [],
      failures: result.failed.map(sanitize),
    };
  }

  const changes = baselineReset ? [] : diff(previous.prs, result.rows);
  const sync = store.commit({
    provider,
    viewer: result.viewer,
    repos: projects,
    prs: result.rows,
    changes,
    baselineReset,
  });
  return {
    provider,
    sync,
    prs: result.rows,
    changes,
    failures: [],
    baselineReset,
    at: new Date(sync.at),
    viewer: result.viewer,
  };
}

/** Syncs every configured provider, independently and in parallel. */
export async function performSync(
  store: Store,
  projects: Record<Provider, string[]>,
  signal?: AbortSignal,
): Promise<SyncOutcome> {
  const settled = await Promise.allSettled(
    PROVIDER_ORDER.map((provider) =>
      syncProvider(store, provider, projects[provider], signal),
    ),
  );

  const byProvider = settled.map((outcome, index) => {
    const provider = PROVIDER_ORDER[index]!;
    if (outcome.status === "fulfilled") return outcome.value;
    // A throw is this provider's failure alone. Its stored rows stay on screen —
    // dropping them would read as "everything there was merged".
    const previous = store.read(provider);
    return {
      provider,
      sync: previous.sync,
      prs: previous.prs,
      changes: previous.changes,
      // Server-supplied text reaching the terminal. Sanitised here rather than in
      // each provider, so the boundary is one place: this also covers subprocess
      // stderr embedded in a token error, which `glab` styles with ANSI.
      failures: [sanitize(`${provider}: ${outcome.reason?.message ?? outcome.reason}`)],
      baselineReset: previous.sync?.baselineReset ?? false,
      at: previous.sync === null ? null : new Date(previous.sync.at),
      viewer: previous.sync?.viewer ?? "",
    } satisfies ProviderOutcome;
  });

  return collate(byProvider);
}

/** Reads every provider's stored state without touching the network. */
export function readAll(store: Store): SyncOutcome {
  return collate(
    PROVIDER_ORDER.map((provider) => {
      const state = store.read(provider);
      return {
        provider,
        sync: state.sync,
        prs: state.prs,
        changes: state.changes,
        failures: state.incomplete
          ? [`${provider}: stored state was unreadable in part`]
          : [],
        baselineReset: state.sync?.baselineReset ?? false,
        at: state.sync === null ? null : new Date(state.sync.at),
        viewer: state.sync?.viewer ?? "",
      } satisfies ProviderOutcome;
    }),
  );
}

function collate(byProvider: ProviderOutcome[]): SyncOutcome {
  return {
    byProvider,
    prs: byProvider.flatMap((p) => p.prs),
    changes: byProvider.flatMap((p) => p.changes),
    failures: byProvider.flatMap((p) => p.failures),
  };
}

/**
 * The age shown for a mixed board: the **oldest** baseline, never the newest.
 * A fresh half must not hide a stale one.
 */
export function oldestSync(byProvider: ProviderOutcome[]): Date | null {
  const times = byProvider
    .filter((p) => p.prs.length > 0 || p.sync !== null)
    .map((p) => p.at)
    .filter((at): at is Date => at !== null);
  if (times.length === 0) return null;
  return times.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
}

/** Every viewer that contributed rows, for the header. */
export function viewersOf(byProvider: ProviderOutcome[]): string {
  return [...new Set(byProvider.filter((p) => p.viewer !== "").map((p) => p.viewer))].join(
    " · ",
  );
}

export function parseArgs(argv: string[]): {
  command: string | undefined;
  statePath: string | undefined;
} {
  let statePath: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--state") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--state needs a path");
      }
      statePath = value;
      continue;
    }
    // Read positionally, the subcommand was invisible behind a preceding flag:
    // `prq --state x sync` silently opened the dashboard instead of syncing.
    if (!arg.startsWith("-")) positional.push(arg);
  }
  return { command: positional[0], statePath };
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

/** Exits non-zero without printing again — the message is already out. */
class SilentFailure extends Error {}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { command, statePath: override } = parseArgs(args);

  if (args.includes("--help") || args.includes("-h")) {
    let effective = storePath();
    try {
      const { statePath } = await loadConfig();
      effective = resolveStorePath(override ?? statePath);
    } catch {
      // No config yet; the default is the honest answer.
    }
    process.stdout.write(
      "prq — open pull and merge requests that concern you\n\n" +
        "  prq            open the dashboard on the last synced state\n" +
        "  prq sync       sync every configured provider, then report what changed\n" +
        "  prq init       write an example config\n" +
        "  --state <path> use this state database instead of the configured one\n" +
        `\nconfig: ${configPath()}\nstate:  ${effective}\n`,
    );
    return;
  }

  if (command === "init") {
    await initConfig();
    return;
  }

  const config = await loadConfig();
  const store = await Store.open(resolveStorePath(override ?? config.statePath));

  // Every path out of here must close the store, or the WAL sidecars outlive the
  // process still carrying a copy of the data.
  try {
    if (command === "sync") {
      const outcome = await performSync(store, config.projects);
      for (const failure of outcome.failures) {
        process.stderr.write(`INCOMPLETE — ${failure}\n`);
      }
      for (const p of outcome.byProvider) {
        if (p.prs.length === 0 && p.sync === null && p.failures.length === 0) continue;
        const state =
          p.failures.length > 0
            ? "not committed"
            : p.baselineReset
              ? "baseline set"
              : `${p.changes.length} change(s)`;
        process.stdout.write(`${p.provider}: ${p.prs.length} open, ${state}\n`);
      }
      if (outcome.failures.length > 0) throw new SilentFailure();
      return;
    }

    const initial = readAll(store);
    await runApp({
      prs: initial.prs,
      changes: initial.changes,
      viewer: viewersOf(initial.byProvider),
      repos: [...config.projects.github, ...config.projects.gitlab],
      lastSync: oldestSync(initial.byProvider),
      baselineReset: initial.byProvider.some((p) => p.baselineReset),
      failures: initial.failures,
      sync: async (signal: AbortSignal) => {
        const next = await performSync(store, config.projects, signal);
        return {
          prs: next.prs,
          changes: next.changes,
          failures: next.failures,
          at: oldestSync(next.byProvider) ?? new Date(),
          viewer: viewersOf(next.byProvider),
          baselineReset: next.byProvider.some((p) => p.baselineReset),
        };
      },
    });
  } finally {
    store.close();
  }
}

// Only when run as the program. Importing this module — as the tests do, for
// `syncProvider` and `parseArgs` — must not execute the CLI.
if (import.meta.main) {
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
}
