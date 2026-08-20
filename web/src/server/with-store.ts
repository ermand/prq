/**
 * The one place the web server opens the database.
 *
 * Extracted when a second server surface (the census dashboards) arrived. A
 * handle is opened and closed per request rather than held: a long-lived one
 * outlives dev-server hot reloads, and its WAL sidecars outlive the process
 * still carrying a copy of the data — the same reason the CLI closes in
 * `finally`.
 */

import { loadConfig } from "../../../src/config";
import type { PersonRule } from "../../../src/census";
import type { Provider } from "../../../src/domain";
import { resolveStorePath, Store } from "../../../src/store";
import { openTracking } from "../../../src/tracking";

export interface StoreContext {
  /** From the store, never the config — see `tracking.ts`. */
  projects: Record<Provider, string[]>;
  people: PersonRule[];
  notices: string[];
}

export async function withStore<T>(
  use: (store: Store, context: StoreContext) => T | Promise<T>,
): Promise<T> {
  const config = await loadConfig();
  // `prq web --state <path>` reaches the server through the environment, since
  // the Vite child process does not see the CLI's argv.
  const store = await Store.open(
    resolveStorePath(process.env.PRQ_STATE ?? config.statePath),
  );
  try {
    const tracking = openTracking(store, config, new Date());
    return await use(store, tracking);
  } finally {
    store.close();
  }
}
