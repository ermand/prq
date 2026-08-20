/**
 * What prq tracks: which projects, and who the people are.
 *
 * The dividing line, after moving both into the database: **config says where
 * the database is, and the database says everything else.** `statePath` cannot
 * live in the store — you need it to find the store — and nothing else needs to
 * be in a file.
 *
 * This module is the only place that knows both sides. `store.ts` does not know
 * what a config file is, and `config.ts` does not know there is a database.
 *
 * The seeding rule was established by driving `tracking-model.prototype.ts` by
 * hand, and the marker in it is load-bearing: with "import when the table is
 * empty" instead, deleting your last project resurrects the entire config on the
 * next launch. Seeding happens once per database and is recorded.
 */

import type { PersonRule } from "./census";
import type { Config } from "./config";
import type { Provider } from "./domain";
import type { Store } from "./store";

export interface Tracking {
  /** Effective project lists — always the store's, never the config's. */
  projects: Record<Provider, string[]>;
  /** Effective identity rules, carrying stored ids. */
  people: PersonRule[];
  /**
   * Things worth saying out loud once. Non-fatal: a config that still lists
   * projects is stale rather than broken, and silently ignoring a file the user
   * is still editing is worse than telling them.
   */
  notices: string[];
}

export function openTracking(store: Store, config: Config, at: Date): Tracking {
  const notices: string[] = [];

  if (!store.isSeeded()) {
    const seeded = store.seedTracking(config.projects, config.people, at);
    if (seeded) {
      const count = config.projects.github.length + config.projects.gitlab.length;
      if (count > 0 || config.people.length > 0) {
        notices.push(
          `imported ${count} project(s) and ${config.people.length} identity rule(s) from the config into the database — ` +
            `they are now managed there, and you can delete those keys from ${"config.yaml"}`,
        );
      }
    }
  } else if (config.projects.github.length + config.projects.gitlab.length > 0) {
    // Deliberately loud and repeated. The alternative is a config file that
    // looks authoritative, is edited, and changes nothing.
    notices.push(
      "config still lists projects under `github:`/`gitlab:` — those keys are no longer read; " +
        "the database is the source of truth. Delete them to stop this notice.",
    );
  } else if (config.people.length > 0) {
    notices.push(
      "config still has a `people:` block — no longer read; identities are stored in the database.",
    );
  }

  return {
    projects: store.projectsByProvider(),
    people: store.personRules(),
    notices,
  };
}
