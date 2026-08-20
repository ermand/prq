#!/usr/bin/env bun
/**
 * PROTOTYPE — throwaway shell. `bun run prototype:activity`
 *
 * Drives `activity-model.prototype.ts` by hand, in memory, with no database.
 *
 * The cases worth pressing:
 *   - `p` twice to make a project inactive, then `f` to fetch: it must be skipped
 *     while its rows and everybody's totals stay put.
 *   - `n` to mark somebody inactive, then `w` to give them new work: the mark must
 *     survive, and the contradiction must be visible rather than silently resolved.
 *   - `d` to untrack a project and compare: untracked hides history, inactive
 *     keeps it. If those two feel the same, one of them should not exist.
 */

import {
  hiddenRows,
  initial,
  reduce,
  repoView,
  rosterView,
  visibleRoster,
  type Action,
} from "./activity-model.prototype";

const B = "\x1b[1m";
const D = "\x1b[2m";
const R = "\x1b[0m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const M = "\x1b[35m";

let state = initial();
let show = { inactive: false, bots: false };

function frame(): void {
  console.clear();
  process.stdout.write(
    `${B}prq — activity model prototype${R} ${D}(in memory; fetch round ${state.round})${R}\n\n`,
  );

  process.stdout.write(`${B}projects${R} ${D}only an active one is ever fetched${R}\n`);
  for (const repo of repoView(state)) {
    const mark = repo.active ? `${G}active  ${R}` : `${Y}inactive${R}`;
    process.stdout.write(
      `  ${mark} ${repo.key.padEnd(30)} ${D}${String(repo.rows).padStart(2)} row(s), ` +
        `${repo.contributors} contributor(s), last fetch ${repo.lastFetch ?? "never"}${R}\n`,
    );
  }

  process.stdout.write(
    `\n${B}roster${R} ${D}showing inactive: ${show.inactive ? "yes" : "no"}, bots: ${
      show.bots ? "yes" : "no"
    }${R}\n`,
  );
  const shown = visibleRoster(state, show);
  for (const entry of shown) {
    const marks = [
      entry.active ? `${G}active${R}` : `${Y}inactive${R}`,
      entry.bot ? `${M}bot${R}` : "",
    ]
      .filter((s) => s !== "")
      .join(" ");
    process.stdout.write(
      `  ${entry.label.padEnd(18)} ${marks.padEnd(22)} ${D}${entry.rows} row(s)${R}` +
        (entry.contradiction ? `  ${C}← inactive, but shipped this round${R}` : "") +
        "\n",
    );
  }
  const all = rosterView(state);
  const hiddenPeople = all.length - shown.length;
  if (hiddenPeople > 0) {
    const inactive = all.filter((e) => !e.active && !e.bot).length;
    const bots = all.filter((e) => e.bot).length;
    process.stdout.write(
      `  ${D}${hiddenPeople} hidden — ${inactive} inactive, ${bots} bot(s)${R}\n`,
    );
  }

  const hidden = hiddenRows(state);
  process.stdout.write(
    `\n${B}untracked history${R} ${
      hidden === 0 ? `${D}none${R}` : `${Y}${hidden} row(s) on disk, shown nowhere${R}`
    }\n`,
  );

  process.stdout.write(`\n${B}log${R}\n`);
  for (const line of state.log) process.stdout.write(`  ${D}${line}${R}\n`);

  process.stdout.write(
    `\n${D}${"─".repeat(74)}${R}\n` +
      `${B}p${R} toggle project  ${B}d${R} untrack project  ${B}f${R} fetch  ${B}w${R} new work\n` +
      `${B}n${R} toggle person   ${B}i${R} show inactive   ${B}b${R} show bots  ${B}q${R} quit\n`,
  );
}

const stdin = console[Symbol.asyncIterator]();

async function nextLine(): Promise<string> {
  const { value, done } = await stdin.next();
  return done ? "" : String(value).trim();
}

async function ask(prompt: string): Promise<string> {
  process.stdout.write(`\n${prompt} `);
  return await nextLine();
}

async function handle(k: string): Promise<boolean> {
  const dispatch = (action: Action) => {
    state = reduce(state, action);
  };

  switch (k) {
    case "p":
    case "d": {
      state.projects.forEach((p, i) =>
        process.stdout.write(`\n  ${i + 1}) ${p.provider} ${p.path} ${p.active ? "" : "(inactive)"}`),
      );
      const n = Number(await ask(k === "p" ? "toggle which?" : "untrack which?"));
      const chosen = state.projects[n - 1];
      if (chosen) {
        dispatch(
          k === "p"
            ? { kind: "toggle-project", provider: chosen.provider, path: chosen.path }
            : { kind: "remove-project", provider: chosen.provider, path: chosen.path },
        );
      }
      return true;
    }

    case "n": {
      state.people.forEach((p, i) =>
        process.stdout.write(`\n  ${i + 1}) ${p.label} ${p.active ? "" : "(inactive)"}`),
      );
      const n = Number(await ask("toggle which?"));
      const chosen = state.people[n - 1];
      if (chosen) dispatch({ kind: "toggle-person", id: chosen.id });
      return true;
    }

    case "f":
      dispatch({ kind: "fetch" });
      return true;

    case "w": {
      state.people.forEach((p, i) => process.stdout.write(`\n  ${i + 1}) ${p.label}`));
      const who = state.people[Number(await ask("new work by whom?")) - 1];
      if (!who) return true;
      const [provider, author] = [who.id.slice(0, who.id.indexOf(":")), who.id.slice(who.id.indexOf(":") + 1)];
      state.projects.forEach((p, i) => process.stdout.write(`\n  ${i + 1}) ${p.path}`));
      const where = state.projects[Number(await ask("in which project?")) - 1];
      if (where && (provider === "github" || provider === "gitlab")) {
        dispatch({ kind: "new-work", provider, path: where.path, author });
      }
      return true;
    }

    case "i":
      show = { ...show, inactive: !show.inactive };
      return true;

    case "b":
      show = { ...show, bots: !show.bots };
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
