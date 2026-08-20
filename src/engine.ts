/**
 * Orchestration shared by every front-end: read the store, or sync and diff.
 *
 * Deliberately free of any renderer import. This lived in `cli.ts` until a second
 * front-end arrived, at which point importing `readAll` also dragged
 * `@opentui/core` — a terminal renderer — into a web server bundle.
 *
 * Providers sync **independently**: each commits its own baseline, so one being
 * unreachable freezes only its own diff.
 */

import type { CensusClient } from "./census";
import { diff, type Change } from "./changes";
import { sanitize, type Provider, type PullRequest } from "./domain";
import { github, githubCensus } from "./github";
import { gitlab, gitlabCensus } from "./gitlab";
import type { ProviderClient } from "./providers";
import type { Store, SyncRecord } from "./store";

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
      // Server-supplied text reaching a renderer. Sanitised here rather than in
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

/**
 * Census orchestration.
 *
 * Separate from `syncProvider` on purpose. A sync is fast, ego-scoped and
 * destructive; a census is slow, repo-wide and accumulative, and the two must
 * never share a code path or a table.
 */

export interface CensusProgress {
  provider: Provider;
  repo: string;
  /** 1-based, over every project in the run. */
  index: number;
  total: number;
  prs: number;
  reviews: number;
  failed: string | null;
  truncated: boolean;
}

const CENSUS_CLIENTS: Record<Provider, CensusClient> = {
  github: githubCensus,
  gitlab: gitlabCensus,
};

/**
 * Censuses every configured project, one at a time, committing each as it lands.
 *
 * Sequential by design. GitHub's secondary rate limits punish concurrency far
 * harder than the primary budget this costs (55 points of 5000), and a project
 * committed the moment it is read means an interrupted census keeps everything
 * it already earned.
 *
 * `since` is deliberately not plumbed through from the CLI. `writeCensus` is a
 * full replace scoped to one project, so a bounded walk would delete the
 * history and write back only the recent slice — the flag would silently
 * destroy exactly the data it appears to preserve. An incremental census needs
 * a merging write first.
 */
export async function performCensus(
  store: Store,
  projects: Record<Provider, string[]>,
  onProgress?: (progress: CensusProgress) => void,
  signal?: AbortSignal,
): Promise<CensusProgress[]> {
  const queue = PROVIDER_ORDER.flatMap((provider) =>
    (projects[provider] ?? []).map((repo) => ({ provider, repo })),
  );
  const done: CensusProgress[] = [];

  for (const [i, { provider, repo }] of queue.entries()) {
    signal?.throwIfAborted();
    let progress: CensusProgress;
    try {
      const census = await CENSUS_CLIENTS[provider].censusRepo(repo, null, signal);
      store.writeCensus(census, new Date());
      progress = {
        provider,
        repo,
        index: i + 1,
        total: queue.length,
        prs: census.prs.length,
        reviews: census.reviews.length,
        failed: census.failed,
        truncated: census.truncated,
      };
    } catch (error: unknown) {
      // One unreachable project must not abandon the rest of the run — the
      // driver's GitLab token has expired mid-operation before.
      if (signal?.aborted) throw error;
      progress = {
        provider,
        repo,
        index: i + 1,
        total: queue.length,
        prs: 0,
        reviews: 0,
        failed: sanitize(error instanceof Error ? error.message : String(error)),
        truncated: false,
      };
      store.writeCensus(
        {
          provider,
          repo,
          prs: [],
          reviews: [],
          reviewPrecision: "exact",
          failed: progress.failed,
          truncated: false,
        },
        new Date(),
      );
    }
    done.push(progress);
    onProgress?.(progress);
  }

  return done;
}
