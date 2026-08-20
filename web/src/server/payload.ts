/**
 * The wire shape of the board, and the conversion into it.
 *
 * Separate from `board.ts` so it carries no TanStack Start import and can be
 * tested directly. Everything here is pure.
 */

import type { Change } from "../../../src/changes";
import type { Provider, PullRequest } from "../../../src/domain";
import { oldestSync, viewersOf, type SyncOutcome } from "../../../src/engine";

export interface ProviderSummary {
  provider: Provider;
  open: number;
  /** ISO, or null when this provider has never committed a baseline. */
  at: string | null;
  changes: number;
  baselineReset: boolean;
  failures: string[];
}

export interface BoardPayload {
  prs: PullRequest[];
  changes: Change[];
  failures: string[];
  /** Every forge identity that contributed rows, joined for the header. */
  viewer: string;
  /** ISO of the *oldest* baseline: a fresh half must not hide a stale one. */
  lastSync: string | null;
  /**
   * The server's clock when this payload was built. Ages are rendered against
   * this rather than `new Date()`, so SSR and hydration agree exactly instead of
   * differing by the milliseconds between them.
   */
  now: string;
  baselineReset: boolean;
  projects: string[];
  byProvider: ProviderSummary[];
}

/** `Date` does not survive the wire, so the client is given ISO strings. */
export function toPayload(
  outcome: SyncOutcome,
  projects: Record<Provider, string[]>,
  now: Date,
): BoardPayload {
  const at = oldestSync(outcome.byProvider);
  return {
    prs: outcome.prs,
    changes: outcome.changes,
    failures: outcome.failures,
    viewer: viewersOf(outcome.byProvider),
    lastSync: at === null ? null : at.toISOString(),
    now: now.toISOString(),
    baselineReset: outcome.byProvider.some((p) => p.baselineReset),
    projects: [...projects.github, ...projects.gitlab],
    byProvider: outcome.byProvider.map((p) => ({
      provider: p.provider,
      open: p.prs.length,
      at: p.at === null ? null : p.at.toISOString(),
      changes: p.changes.length,
      baselineReset: p.baselineReset,
      failures: p.failures,
    })),
  };
}
