/**
 * The write surface: which projects are tracked, and who the people are.
 *
 * These are the first mutations in the app, and they are worth being precise
 * about. prq is read-only **against the forges** — it never approves, comments
 * or merges, and every outbound action is an anchor you click. Nothing here
 * changes that: these write local rows, in the same database a sync and a census
 * already write. What they cannot do is touch the network.
 *
 * The rules they implement were validated by driving `tracking-model.prototype.ts`
 * by hand. Two are easy to get wrong:
 *
 *   - Removing a project keeps its census rows. Every census read filters on
 *     tracked projects, so a mis-click costs nothing and re-adding restores the
 *     history without the ~2m21s a census takes.
 *   - A rename materialises both the `person` row and its alias row. Without the
 *     alias, renaming somebody and then untracking their only project left a name
 *     attached to no account.
 */

import { createServerFn } from "@tanstack/react-start";
import { isBot } from "../../../src/census";
import type { Provider } from "../../../src/domain";
import { withStore } from "./with-store";

export interface ProjectRow {
  provider: Provider;
  path: string;
  addedAt: string;
  /** False when marked inactive: still tracked and counted, never fetched. */
  active: boolean;
  /** Census rows on hand, so the UI can say what removing would hide. */
  stored: number;
  censusAt: string | null;
}

export interface SettingsPayload {
  projects: ProjectRow[];
  /** Rows belonging to projects no longer tracked — reclaimable, and invisible. */
  orphanRows: number;
  /** Stale config keys, reported once rather than silently ignored. */
  notices: string[];
  configPath: string;
}

/**
 * Turns an untrusted payload into something checked. `Object.entries` needs a
 * real object and yields real entries, so nothing here asserts a shape it has
 * not verified — every value comes out as `unknown` and has to be narrowed.
 */
function fields(data: unknown): Map<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("expected an object payload");
  }
  return new Map(Object.entries(data));
}

function parseProvider(value: unknown): Provider {
  if (value !== "github" && value !== "gitlab") {
    throw new Error("provider must be github or gitlab");
  }
  return value;
}

function parseText(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${what} is required`);
  }
  return value.trim();
}

function parseProject(data: unknown): { provider: Provider; path: string } {
  const input = fields(data);
  return {
    provider: parseProvider(input.get("provider")),
    path: parseText(input.get("path"), "project path"),
  };
}

function parseId(data: unknown): { id: string } {
  return { id: parseText(fields(data).get("id"), "person id") };
}
export const getSettings = createServerFn({ method: "GET" }).handler(() =>
  withStore((store, { notices }): SettingsPayload => {
    const tracked = store.projects();
    const runs = store.censusRuns();
    const counts = new Map<string, number>();
    for (const pr of store.censusPrs()) {
      const key = `${pr.provider}:${pr.repo}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    let orphanRows = 0;
    for (const [key, n] of counts) {
      if (!tracked.some((p) => `${p.provider}:${p.path}` === key)) orphanRows += n;
    }

    return {
      projects: tracked.map((p) => {
        const key = `${p.provider}:${p.path}`;
        const run = runs.find((r) => `${r.provider}:${r.repo}` === key);
        return {
          provider: p.provider,
          path: p.path,
          addedAt: p.addedAt,
          active: p.active,
          stored: counts.get(key) ?? 0,
          censusAt: run?.at.toISOString() ?? null,
        };
      }),
      orphanRows,
      notices,
      configPath: process.env.PRQ_STATE ?? "",
    };
  }),
);

export const addProject = createServerFn({ method: "POST" })
  .validator(parseProject)
  .handler(({ data }) =>
    withStore((store) => {
      // The store validates the path shape at the sink and throws; letting that
      // reach the client is the point, since the message names the fix.
      const added = store.addProject(data.provider, data.path, new Date());
      return { added, path: data.path };
    }),
  );

export const removeProject = createServerFn({ method: "POST" })
  .validator(parseProject)
  .handler(({ data }) =>
    withStore((store) => ({
      removed: store.removeProject(data.provider, data.path),
    })),
  );

export const purgeUntracked = createServerFn({ method: "POST" }).handler(() =>
  withStore((store) => ({ deleted: store.purgeUntracked() })),
);

/**
 * Marking a project inactive stops it being fetched, and does nothing else. Its
 * stored history keeps counting on every page, because history is a record —
 * archiving a dormant repository must not erase the eleven pull requests
 * somebody really wrote in it.
 */
export const setProjectActive = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const input = fields(data);
    return {
      ...parseProject(data),
      active: input.get("active") === true,
    };
  })
  .handler(({ data }) =>
    withStore((store) => ({
      changed: store.setProjectActive(data.provider, data.path, data.active),
      active: data.active,
    })),
  );

/**
 * Marking a person inactive takes them off the roster by default and leaves
 * every number they contributed exactly where it was. Somebody leaving does not
 * un-write their code, so a project's history must not rewrite itself.
 */
export const setPersonActive = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const input = fields(data);
    return {
      id: parseText(input.get("id"), "person id"),
      active: input.get("active") === true,
    };
  })
  .handler(({ data }) =>
    withStore((store) => {
      store.setPersonActive(data.id, data.active, new Date());
      return { id: data.id, active: data.active };
    }),
  );

export const renamePerson = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const input = fields(data);
    return {
      id: parseText(input.get("id"), "person id"),
      label: parseText(input.get("label"), "name"),
    };
  })
  .handler(({ data }) =>
    withStore((store) => {
      store.renamePerson(data.id, data.label, new Date());
      return { id: data.id, label: data.label };
    }),
  );

/**
 * Clearing a name is deletion, not a rename to the empty string — a person with
 * a blank label would render as a nameless row. Dropping the stored label falls
 * the display back to the forge login, which is where it started.
 */
export const clearPersonName = createServerFn({ method: "POST" })
  .validator(parseId)
  .handler(({ data }) =>
    withStore((store) => {
      const login = data.id.includes(":") ? data.id.slice(data.id.indexOf(":") + 1) : data.id;
      store.renamePerson(data.id, login, new Date());
      return { id: data.id, label: login };
    }),
  );

export interface LinkableIdentity {
  id: string;
  label: string;
  accounts: string[];
  bot: boolean;
  /**
   * Same display name as the person being linked to. Observed in real use: the
   * driver named `github:mhysollari` and `gitlab:marin.hysollari` "Marin
   * Hysollari" a minute apart, which is one human typed twice rather than
   * linked. Two identical names is the strongest merge signal there is, so it is
   * surfaced instead of left for the eye to catch.
   */
  sameName: boolean;
}

/** Candidates for a merge: every other person, so the UI need not guess. */
export const getLinkable = createServerFn({ method: "GET" })
  .validator(parseId)
  .handler(({ data }) =>
    withStore((store, { people: rules }): LinkableIdentity[] => {
      const claimed = new Map<string, { label: string; accounts: string[] }>();
      for (const rule of rules) {
        const id = rule.id ?? rule.label;
        claimed.set(id, {
          label: rule.label,
          accounts: rule.aliases.map((a) => `${a.provider}:${a.username}`),
        });
      }

      // The target's own name, which is what `sameName` compares against. An
      // unnamed person falls back to their login, exactly as the roster does.
      const mine = normalise(claimed.get(data.id)?.label ?? loginOf(data.id));

      const rows: LinkableIdentity[] = [];
      const seen = new Set<string>();
      for (const [id, entry] of claimed) {
        seen.add(id);
        for (const account of entry.accounts) seen.add(account);
        if (id !== data.id) {
          rows.push({
            id,
            label: entry.label,
            accounts: entry.accounts,
            bot: false,
            sameName: normalise(entry.label) === mine,
          });
        }
      }
      for (const contributor of store.contributors()) {
        const key = `${contributor.provider}:${contributor.username}`;
        if (seen.has(key) || key === data.id) continue;
        rows.push({
          id: key,
          label: contributor.username,
          accounts: [key],
          bot: isBot(contributor.username),
          sameName: normalise(contributor.username) === mine,
        });
      }

      // Same name first, bots last, then alphabetical. The candidate list runs to
      // ~31 entries, so the one the driver almost certainly wants must not be
      // somewhere in the middle of it.
      return rows.sort(
        (a, b) =>
          Number(b.sameName) - Number(a.sameName) ||
          Number(a.bot) - Number(b.bot) ||
          a.label.localeCompare(b.label),
      );
    }),
  );

function normalise(label: string): string {
  return label.trim().toLowerCase();
}

function loginOf(id: string): string {
  return id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
}

export const linkPerson = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const input = fields(data);
    return {
      fromId: parseText(input.get("fromId"), "source person"),
      intoId: parseText(input.get("intoId"), "target person"),
    };
  })
  .handler(({ data }) =>
    withStore((store) => ({ merged: store.mergePersons(data.fromId, data.intoId, new Date()) })),
  );

export const unlinkAccount = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const input = fields(data);
    return {
      provider: parseProvider(input.get("provider")),
      username: parseText(input.get("username"), "username"),
    };
  })
  .handler(({ data }) =>
    withStore((store) => ({ split: store.splitAlias(data.provider, data.username) })),
  );
