#!/usr/bin/env bun
/**
 * PROTOTYPE — throwaway shell. `bun run prototype:tracking`
 *
 * Nothing here is meant to survive. It exists so the rules in
 * `tracking-model.prototype.ts` can be driven by hand, in-memory, with no
 * database and no forge, until they either hold up or visibly do not.
 *
 * The case worth pressing first: `p` to seed, `d` to delete every project, then
 * `l` to relaunch. If the projects come back, the seeding rule is wrong.
 */

import {
  initial,
  orphanCount,
  reduce,
  repoView,
  rosterView,
  type Action,
  type Observation,
  type State,
} from "./tracking-model.prototype";

const B = "\x1b[1m";
const D = "\x1b[2m";
const R = "\x1b[0m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const C = "\x1b[36m";

/** Stands in for the real config, and for a real census. */
const CONFIG = [
  { provider: "github" as const, path: "nebulaltd/pok-auctions" },
  { provider: "github" as const, path: "nebulaltd/tokitoki" },
  { provider: "gitlab" as const, path: "albanian-technology-distribution/kesh/kesh-back" },
];

const SCAN: Observation[] = [
  { provider: "github", path: "nebulaltd/pok-auctions", author: "ermand" },
  { provider: "github", path: "nebulaltd/pok-auctions", author: "dionverushi" },
  { provider: "github", path: "nebulaltd/tokitoki", author: "ermand" },
  { provider: "github", path: "nebulaltd/tokitoki", author: "luisalla-art" },
  { provider: "gitlab", path: "albanian-technology-distribution/kesh/kesh-back", author: "ermandduro" },
  { provider: "gitlab", path: "albanian-technology-distribution/kesh/kesh-back", author: "kaziu" },
  { provider: "github", path: "nebulaltd/smip", author: "merkuriendi" },
];

let state = initial(CONFIG);

function frame(): void {
  console.clear();
  const orphans = orphanCount(state);

  process.stdout.write(`${B}prq — tracking model prototype${R} ${D}(in memory; no database)${R}\n\n`);

  process.stdout.write(`${B}config.yaml${R} ${D}projects still listed${R}\n`);
  if (state.configProjects.length === 0) process.stdout.write(`  ${D}(none)${R}\n`);
  for (const p of state.configProjects) {
    const honoured = state.seeded ? `${Y}ignored${R}` : `${D}pending import${R}`;
    process.stdout.write(`  ${D}${p.provider}${R} ${p.path}  ${honoured}\n`);
  }
  process.stdout.write(
    `  ${D}seeded:${R} ${state.seeded ? `${G}yes${R}` : `${Y}no${R}`}\n\n`,
  );

  process.stdout.write(`${B}projects${R} ${D}tracked — what a sync and a census read${R}\n`);
  if (state.projects.length === 0) process.stdout.write(`  ${D}(none tracked)${R}\n`);
  for (const r of repoView(state)) {
    process.stdout.write(`  ${D}${r.provider}${R} ${r.path} ${D}— ${r.rows} row(s)${R}\n`);
  }

  process.stdout.write(`\n${B}people${R} ${D}as the roster would show them${R}\n`);
  if (rosterView(state).length === 0) process.stdout.write(`  ${D}(nobody)${R}\n`);
  for (const p of rosterView(state)) {
    const named = state.persons.some((x) => x.id === p.id) ? `${C}named${R}` : `${D}login${R}`;
    process.stdout.write(
      `  ${p.label.padEnd(18)} ${named}  ${D}${p.accounts.join(" + ") || "no accounts"}${R}  ${p.rows} row(s)\n`,
    );
  }

  process.stdout.write(
    `\n${B}on disk but hidden${R} ${orphans === 0 ? `${D}none${R}` : `${Y}${orphans} row(s) of untracked history${R}`}\n`,
  );

  process.stdout.write(`\n${B}log${R}\n`);
  for (const line of state.log) process.stdout.write(`  ${D}${line}${R}\n`);

  process.stdout.write(
    `\n${D}${"─".repeat(72)}${R}\n` +
      `${B}l${R} launch  ${B}a${R} add project  ${B}d${R} remove project  ${B}c${R} census  ${B}x${R} purge hidden\n` +
      `${B}n${R} rename person  ${B}m${R} merge  ${B}s${R} split alias  ${B}e${R} empty config  ${B}q${R} quit\n`,
  );
}

/**
 * One reader for the whole process. A nested `for await (… of console)` inside
 * the main loop locks the stream — `ReadableStream is locked` — so every prompt
 * pulls from this same iterator.
 */
const stdin = console[Symbol.asyncIterator]();

async function nextLine(): Promise<string> {
  const { value, done } = await stdin.next();
  return done ? "" : String(value).trim();
}

async function ask(prompt: string): Promise<string> {
  process.stdout.write(`\n${prompt} `);
  return await nextLine();
}

function pick<T>(items: T[], label: (item: T) => string, answer: string): T | undefined {
  const n = Number(answer);
  if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1];
  return items.find((i) => label(i) === answer);
}

async function handle(k: string): Promise<boolean> {
  const dispatch = (action: Action) => {
    state = reduce(state, action);
  };

  switch (k) {
    case "l":
      dispatch({ kind: "launch" });
      return true;

    case "a": {
      const known = [...new Set(SCAN.map((o) => `${o.provider} ${o.path}`))];
      known.forEach((s, i) => process.stdout.write(`\n  ${i + 1}) ${s}`));
      const answer = await ask("add which? (number, or 'provider path')");
      const chosen = pick(known, (s) => s, answer) ?? answer;
      const [provider, ...rest] = chosen.split(/\s+/);
      if (provider === "github" || provider === "gitlab") {
        dispatch({ kind: "add-project", provider, path: rest.join(" ") });
      }
      return true;
    }

    case "d": {
      state.projects.forEach((p, i) =>
        process.stdout.write(`\n  ${i + 1}) ${p.provider} ${p.path}`),
      );
      const answer = await ask("remove which? (number, or 'all')");
      if (answer === "all") {
        for (const p of [...state.projects]) {
          dispatch({ kind: "remove-project", provider: p.provider, path: p.path });
        }
        return true;
      }
      const chosen = pick(state.projects, (p) => p.path, answer);
      if (chosen) {
        dispatch({ kind: "remove-project", provider: chosen.provider, path: chosen.path });
      }
      return true;
    }

    case "c":
      dispatch({ kind: "census", observations: SCAN });
      return true;

    case "x":
      dispatch({ kind: "purge-untracked" });
      return true;

    case "n": {
      const roster = rosterView(state);
      roster.forEach((p, i) => process.stdout.write(`\n  ${i + 1}) ${p.label}  ${p.id}`));
      const who = await ask("rename which? (number)");
      const chosen = pick(roster, (p) => p.id, who);
      if (chosen) {
        const label = await ask(`new name for ${chosen.id}?`);
        if (label !== "") dispatch({ kind: "rename", personId: chosen.id, label });
      }
      return true;
    }

    case "m": {
      const roster = rosterView(state);
      roster.forEach((p, i) => process.stdout.write(`\n  ${i + 1}) ${p.label}  ${p.id}`));
      const from = pick(roster, (p) => p.id, await ask("merge which? (number)"));
      const into = pick(roster, (p) => p.id, await ask("into which? (number)"));
      if (from && into) dispatch({ kind: "merge", fromId: from.id, intoId: into.id });
      return true;
    }

    case "s": {
      state.aliases.forEach((a, i) =>
        process.stdout.write(`\n  ${i + 1}) ${a.provider}:${a.username} -> ${a.personId}`),
      );
      const chosen = pick(state.aliases, (a) => a.username, await ask("split which? (number)"));
      if (chosen) {
        dispatch({ kind: "split", provider: chosen.provider, username: chosen.username });
      }
      return true;
    }

    case "e":
      dispatch({ kind: "edit-config", projects: [] });
      return true;

    case "q":
      return false;

    default:
      return true;
  }
}

frame();
for (;;) {
  const line = await nextLine();
  const k = line.slice(0, 1).toLowerCase();
  if (k === "") break;
  if (!(await handle(k))) break;
  frame();
}
process.stdout.write("\n");
