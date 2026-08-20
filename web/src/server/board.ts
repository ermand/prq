/**
 * The entire server surface: read the stored board, or sync it.
 *
 * There is deliberately **no mutation function here**. Acting on a PR is an
 * anchor to the forge, so prq stays read-only structurally rather than by
 * discipline — the same conclusion the TUI reached.
 *
 * `getBoard` touches no network. That is the invariant the whole tool rests on:
 * a page load, or a reload, can never destroy the diff.
 */

import { createServerFn } from "@tanstack/react-start";
import { loadConfig } from "../../../src/config";
import type { Provider } from "../../../src/domain";
import { performSync, readAll } from "../../../src/engine";
import { resolveStorePath, Store } from "../../../src/store";
import { toPayload } from "./payload";

export type { BoardPayload, ProviderSummary } from "./payload";

/**
 * Opened and closed per request rather than held open. A long-lived handle would
 * outlive dev-server hot reloads, and the WAL sidecars would outlive the process
 * still carrying a copy of the data — the same reason the CLI closes in `finally`.
 */
async function withStore<T>(
  use: (store: Store, projects: Record<Provider, string[]>) => T | Promise<T>,
): Promise<T> {
  const config = await loadConfig();
  // `prq web --state <path>` reaches the server through the environment, since
  // the Vite child process does not see the CLI's argv.
  const store = await Store.open(
    resolveStorePath(process.env.PRQ_STATE ?? config.statePath),
  );
  try {
    return await use(store, config.projects);
  } finally {
    store.close();
  }
}

export const getBoard = createServerFn({ method: "GET" }).handler(() =>
  withStore((store, projects) => toPayload(readAll(store), projects, new Date())),
);

export const runSync = createServerFn({ method: "POST" }).handler(() =>
  withStore(async (store, projects) =>
    toPayload(await performSync(store, projects), projects, new Date()),
  ),
);
