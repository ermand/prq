# A web front-end for prq

**Date** 2026-08-20
**Status** approved, implementing
**Destination** a local React dashboard over the same store the TUI reads, with a
per-PR detail panel the terminal has no room for.

## What this is not

Not a hosted service. Two couplings decide that, and both were checked rather
than assumed:

| Coupling | Evidence | Consequence |
| --- | --- | --- |
| Auth comes from local binaries | `github.ts:44` spawns `gh auth token`; `gitlab.ts:390` spawns `glab` | no `gh`/`glab` in a cloud runtime |
| Storage is Bun-native SQLite | `store.ts:18` `import { Database } from "bun:sqlite"` | absent on Workers and edge runtimes |

A hosted prq would need the subprocess transport replaced by raw GraphQL, a
hosted database, forge tokens held as secrets, and a login system. The
front-end would be the small part of that. So this runs on `127.0.0.1`, and
reuse of the existing engine is close to total.

## The seam was already there

`domain.ts` owns `bucketOf`, `groupIntoBuckets`, `flatten`, `compareWithin`.
`changes.ts` owns `byPr`, `headline`, `label`. All pure, all UI-agnostic.
`render.ts` imports from `domain` and only formats strings.

So React replaces the string formatters and reimplements **no** logic. The
bucket rules cannot drift between the two front-ends because there is one copy.
`matchesFilter` and `relativeAge` cross over unchanged.

One seam was *not* already there. `readAll` and `performSync` lived in `cli.ts`,
which imports `./tui`, so importing them would have pulled `@opentui/core` — a
terminal renderer — into a web server bundle. They moved to `src/engine.ts`,
which imports no renderer at all. Only `cli.test.ts` referenced them, so the
cutover was two files and no shims.

## Architecture

One process. `prq web [--port N] [--no-open]` boots Vite and opens a browser.

Server functions are the entire server surface:

- `getBoard()` — wraps `readAll(store)`. Touches no network, ever.
- `runSync()` — wraps `performSync(...)`. Reachable only from the button.

There are **no mutation server functions**. Acting on a PR is an `<a href>` to
the forge, so the read-only guarantee is structural rather than a matter of
discipline. This is the same conclusion the TUI reached, arrived at the same
way: the browser link is how you act.

### Routes

- `/` — the board. Buckets in order, empty ones omitted, because
  `groupIntoBuckets` already omits them. Grouping toggle and filter live in
  typed search params, so they survive refresh and the back button. The TUI
  holds them in memory; this is strictly better.
- The detail panel is a **validated search param on `/`**, not a nested route.
  Planned as `/pr/$provider/$id` until the ids were looked at: GitLab's are
  `gid://gitlab/MergeRequest/507963342`, and repo paths are themselves nested
  (`group/subgroup/project`), so neither the id nor `repo`+`number` survives a
  path segment. `?pr=<id>` sidesteps the escaping entirely, keeps the board
  mounted with no layout route, and still shares and back-buttons correctly.
  Title, author, reviewers, checks, merge state, stale-block status, stack
  membership and that row's change history via `byPr`.

## The invariant that matters

Launch never touches the network. In a browser, where refresh is free, that has
to be deliberate:

| TUI | Web |
| --- | --- |
| launch never networks | the loader calls `getBoard()` only |
| `S` syncs | a button calls `runSync()`, then `router.invalidate()` |
| read-only | zero mutation server functions |
| the diff lives in session memory | the diff is read from the `change` table |

That last row is the one genuine improvement. Changes are already persisted —
48 rows across 24 syncs in the live database — and `store.read()` recovers them
via `changesFor(sync.id)`. So a browser reload preserves the change set, where
a TUI restart would not show it again.

## Runtime: the one real risk, now resolved

Verified in a throwaway project before touching this repo.

`bun run dev` does **not** run Start under Bun. Vite's bin carries
`#!/usr/bin/env node`, so `bun run` honours the shebang and hands the dev server
and all SSR to Node. A server function then fails on `import("bun:sqlite")`:

```
Only URLs with a scheme in: file, data, and node are supported
by the default ESM loader. Received protocol 'bun:'
```

That is Node's loader talking. The fix is the `--bun` flag, which forces
node-shebang binaries onto the Bun runtime:

```bash
bun --bun run dev
```

With it, a server function reported `runtime=bun` and read the real database
through `bun:sqlite` — 31 PR rows and 48 change rows, matching the counts
measured directly. So `store.ts` is reusable unchanged, and `prq web` must
spawn Vite with `--bun`.

Recorded because it is silent: without `--bun` everything installs, boots, and
serves HTML, and only the database access fails.

## TypeScript

The root `tsconfig.json` sets `verbatimModuleSyntax: true`, which the Start docs
warn "can result in server bundles leaking into client bundles". Its `lib` is
`["ESNext"]` with no DOM, and `types` is `["bun"]` with no React.

So `web/` carries its own `tsconfig.json`: `verbatimModuleSyntax` off, DOM libs
added, React types added, still resolving `../src/*` so the domain model is
imported rather than copied.

## Errors

`SyncOutcome.failures` already carries per-provider failures. The board renders
with a banner above it rather than hiding — consistent with the existing
decision that a partial scan keeps previous rows, because showing only the seen
half reads as "everything else was merged". `state.incomplete` gets its own
banner. A failed sync leaves the previous board in place.

The first implementation of this was **wrong, and silently so**. Sync called
`runSync()`, discarded its reply, and invalidated the router so the loader
re-read the store. But a failed scan commits nothing, so its failures are not in
the store and `readAll` cannot recover them: both GitLab projects were
unreachable, the CLI said so twice, and the browser showed a clean board of 22
GitHub rows with no indication that half the configuration had failed. Exactly
the "showing only the half it could see" outcome the engine is written to avoid.

Fixed by keeping the sync's returned `failures` in component state and merging
them with the loader's. They are lost on reload, because nothing persisted them —
the CLI has the same property, having printed them once. Persisting scan failures
would need a schema change and is not in scope here.

Found only by clicking the button against a scratch database. Worth recording as
an argument for driving the real interface rather than reasoning about it.

Departures are the known hole from ticket 0017: a PR that has left the set has
no row to mark. A `left` change carries `from: pr.repo` and nothing else, since
the `pr` table holds only current state. The header names the repos that lost
rows — partial, and better than the TUI's count.

## Testing

The 297 existing tests stay untouched; `domain`, `changes`, and `store` do not
change. Added:

- `getBoard()` spawns no subprocess — the launch-never-networks invariant, as an
  assertion rather than a comment.
- The board groups identically to `groupIntoBuckets`, proving reuse instead of a
  parallel implementation.

No wall-clock timers, per the project rule.

## Out of scope

Trend and history views, though the store retains 24 syncs so they stay
feasible. Auth. Hosting. Any write path to either forge.
