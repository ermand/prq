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
import { dirname, join } from "node:path";
import { configPath, EXAMPLE_CONFIG, loadConfig } from "./config";
import {
  oldestSync,
  performCensus,
  performSync,
  readAll,
  viewersOf,
} from "./engine";
import { resolveStorePath, Store, storePath } from "./store";
import { openTracking } from "./tracking";
import { runApp } from "./tui";

export function parseArgs(argv: string[]): {
  command: string | undefined;
  /** Every positional, including the subcommand — `projects add x` needs them. */
  positional: string[];
  statePath: string | undefined;
  port: number | undefined;
  open: boolean;
} {
  let statePath: string | undefined;
  let port: number | undefined;
  let open = true;
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
    if (arg === "--port") {
      const value = argv[++i];
      // Rejected rather than coerced: `--port abc` silently becoming NaN and
      // then vite's default is a worse outcome than refusing to start.
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new Error("--port needs a number");
      }
      const parsed = Number(value);
      if (parsed < 1 || parsed > 65535) throw new Error("--port is out of range");
      port = parsed;
      continue;
    }
    if (arg === "--no-open") {
      open = false;
      continue;
    }
    // Read positionally, the subcommand was invisible behind a preceding flag:
    // `prq --state x sync` silently opened the dashboard instead of syncing.
    if (!arg.startsWith("-")) positional.push(arg);
  }
  return { command: positional[0], positional, statePath, port, open };
}

/**
 * `prq projects [list | add <provider> <path> | rm <provider> <path>]`
 *
 * The web UI is the comfortable way to do this; a command exists because adding
 * a project is the first thing anybody does and booting a browser to do it is a
 * poor first run.
 */
function projectsCommand(store: Store, args: string[]): void {
  const [action, provider, path] = args;

  if (action === undefined || action === "list") {
    const rows = store.projects();
    if (rows.length === 0) {
      process.stdout.write("no projects tracked\n");
      return;
    }
    for (const row of rows) {
      // The mark is printed, not implied by omission: an inactive project is
      // still tracked and its history still counts, it is merely not fetched.
      process.stdout.write(
        `${row.provider}\t${row.path}${row.active ? "" : "\t(inactive)"}\n`,
      );
    }
    return;
  }

  if (provider !== "github" && provider !== "gitlab") {
    throw new Error(`provider must be github or gitlab, not ${JSON.stringify(provider ?? "")}`);
  }
  if (path === undefined || path === "") {
    throw new Error(`${action} needs a project path`);
  }

  if (action === "add") {
    const added = store.addProject(provider, path, new Date());
    process.stdout.write(
      added
        ? `added ${provider}:${path} — run \`prq sync\` and \`prq census\`\n`
        : `${provider}:${path} was already tracked\n`,
    );
    return;
  }

  if (action === "rm") {
    const removed = store.removeProject(provider, path);
    // Says what it did *not* do, because the history surviving is the surprising
    // half and it is what makes re-adding free.
    process.stdout.write(
      removed
        ? `removed ${provider}:${path} — its stored history is kept, so adding it back needs no census\n`
        : `${provider}:${path} was not tracked\n`,
    );
    return;
  }

  if (action === "deactivate" || action === "activate") {
    const active = action === "activate";
    const changed = store.setProjectActive(provider, path, active);
    process.stdout.write(
      !changed
        ? `${provider}:${path} is not tracked\n`
        : active
          ? `${provider}:${path} is active — it will be fetched again\n`
          : // The half worth stating: it stops being fetched and stops nothing else.
            `${provider}:${path} is inactive — no longer synced or censused, ` +
            `its stored history still counts everywhere\n`,
    );
    return;
  }

  throw new Error(
    `unknown projects action ${JSON.stringify(action)} — list, add, rm, activate or deactivate`,
  );
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

const DEFAULT_WEB_PORT = 4177;

/**
 * Boots the browser dashboard.
 *
 * The store is deliberately **not** opened here: the web server opens it per
 * request, and holding a second handle open for the life of the dev server would
 * leave WAL sidecars behind for no benefit.
 */
async function runWeb(
  override: string | undefined,
  port: number,
  openBrowser: boolean,
): Promise<void> {
  const repo = join(import.meta.dir, "..");
  const config = join(repo, "web", "vite.config.ts");
  const vite = join(repo, "node_modules", "vite", "bin", "vite.js");
  for (const required of [config, vite]) {
    if (!(await Bun.file(required).exists())) {
      throw new Error(
        `missing ${required} — 'prq web' needs the source tree and its installed ` +
          "dependencies, so it does not work from the compiled binary",
      );
    }
  }

  const loaded = await loadConfig();
  const state = resolveStorePath(override ?? loaded.statePath);
  const url = `http://localhost:${port}`;
  process.stdout.write(`prq web — ${url}\nstate:  ${state}\n`);

  // `--bun` is load-bearing, and vite's own binary is invoked directly rather
  // than through a package script. Vite's bin carries `#!/usr/bin/env node`, so
  // anything that honours the shebang hands the dev server and all SSR to Node,
  // where every server function dies on `bun:sqlite` with "Received protocol
  // 'bun:'" — silently, right up until the database is touched.
  //
  // Unlike `open` and `pbcopy`, this child gets the full environment: it *is* the
  // application, and syncing from it shells out to `gh` and `glab`, which need
  // HOME and their own configuration.
  const server = Bun.spawn(
    ["bun", "--bun", vite, "dev", "--config", config, "--port", String(port)],
    {
      cwd: repo,
      env: { ...process.env, PRQ_STATE: state },
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  if (openBrowser) {
    // Waits for the port rather than guessing: opening a browser at a dead
    // address shows an error page the user then has to reload by hand.
    const ready = await waitForPort(port, server);
    if (ready) {
      Bun.spawn(["open", "--", url], { env: { PATH: process.env.PATH ?? "" } });
    }
  }

  const code = await server.exited;
  if (code !== 0) throw new SilentFailure();
}

/** Resolves true once the port accepts a connection, false if the server died. */
async function waitForPort(port: number, server: Bun.Subprocess): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) return false;
    try {
      const socket = await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: { data() {} },
      });
      socket.end();
      return true;
    } catch {
      await Bun.sleep(100);
    }
  }
  return false;
}

/** Exits non-zero without printing again — the message is already out. */
class SilentFailure extends Error {}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { command, positional, statePath: override, port, open } = parseArgs(args);

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
        "  prq web        open the same board in a browser\n" +
        "  prq sync       sync every configured provider, then report what changed\n" +
        "  prq census     read every project's full history, for the dashboards\n" +
        "  prq init       write an example config\n" +
        "  --state <path> use this state database instead of the configured one\n" +
        "  --port <n>     port for `web` (default 4177)\n" +
        "  --no-open      do not launch a browser for `web`\n" +
        `\nconfig: ${configPath()}\nstate:  ${effective}\n`,
    );
    return;
  }

  if (command === "init") {
    await initConfig();
    return;
  }

  if (command === "web") {
    await runWeb(override, port ?? DEFAULT_WEB_PORT, open);
    return;
  }

  const config = await loadConfig();
  const store = await Store.open(resolveStorePath(override ?? config.statePath));

  // Seeds a fresh database from the config once, then reads the store for good.
  const tracking = openTracking(store, config, new Date());
  for (const notice of tracking.notices) process.stderr.write(`note: ${notice}\n`);

  if (
    tracking.projects.github.length + tracking.projects.gitlab.length === 0 &&
    command !== "projects"
  ) {
    // Said here rather than thrown from the parser: the fix is a command, not an
    // edit to a file.
    process.stderr.write(
      "no projects tracked — add one with `prq projects add github owner/repo`\n",
    );
  }

  // Every path out of here must close the store, or the WAL sidecars outlive the
  // process still carrying a copy of the data.
  try {
    if (command === "projects") {
      projectsCommand(store, positional.slice(1));
      return;
    }

    if (command === "sync") {
      const outcome = await performSync(store, tracking.projects);
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

    if (command === "census") {
      // Progress is printed as each project lands, not collected and dumped at
      // the end: the run takes minutes, and silence for minutes is
      // indistinguishable from a hang.
      const runs = await performCensus(store, config.projects, (p) => {
        const state = p.failed !== null ? `FAILED — ${p.failed}` : p.truncated
          ? `${p.prs} pull requests, TRUNCATED at the paging ceiling`
          : `${p.prs} pull requests, ${p.reviews} review(s)`;
        process.stdout.write(`[${p.index}/${p.total}] ${p.provider}:${p.repo} — ${state}\n`);
      });
      const failed = runs.filter((r) => r.failed !== null);
      const total = runs.reduce((n, r) => n + r.prs, 0);
      process.stdout.write(
        `\n${total} pull requests across ${runs.length - failed.length} project(s)\n`,
      );
      if (failed.length > 0) throw new SilentFailure();
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
