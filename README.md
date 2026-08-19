# prq

A terminal dashboard for the pull requests that concern you, across a saved list
of GitHub repositories — grouped by what you should do next, and able to tell you
what changed since you last looked.

## Setup

```bash
bun install
bun src/cli.ts init      # writes an example config
```

Then edit `~/.config/prq/config.yaml`:

```yaml
repos:
  - owner/repo
  - owner/another-repo

# Optional. Omit for ~/.local/state/prq/state.db.
# A relative path resolves against the directory you run prq from.
statePath: .prq/state.db
```

Authentication comes from `gh auth login`, or a `GITHUB_TOKEN` / `GH_TOKEN`
environment variable. Nothing else to configure.

## Running

```bash
bun start        # open the dashboard
bun run sync     # sync now, from the shell
```

**Launch never touches the network.** It reads the last synced state and paints
instantly. Syncing is always something you ask for — press `S` in the dashboard,
or run `bun run sync`. That is the whole point: you own the baseline, so a
refresh you did not ask for cannot destroy the diff of what changed.

On a first run the store is empty, so the dashboard has nothing to show until you
sync once.

### Keys

| Key | Does |
| --- | --- |
| `j` / `k` | move |
| `o` | open in the browser |
| `y` | copy the URL |
| `S` | sync — press again to cancel |
| `c` | show only what changed in the last sync |
| `s` | focus the stack under the cursor, or leave it |
| `g` | drop the bucket grouping |
| `/` | filter by repo, title, author or number |
| `?` | help |
| `q` | quit |

### Reading the header

```
ermand · 29 PRs · 5 repos · 2h ago · 13 changed · 5 gone
```

- **`2h ago`** — the age of the last sync. If it says two hours, you are looking
  at two-hour-old data. Press `S`.
- **`13 changed`** — PRs that moved, and that have a row you can see. `c` narrows
  to exactly these.
- **`5 gone`** — PRs that left the set, merged or closed. Counted separately
  because they have no row to show, so `c` cannot narrow to them.
- **`baseline set`** — a first sync. Nothing was comparable, so nothing is
  reported. The next sync will report properly.
- **`INCOMPLETE — not committed`** — one half of the scan failed. The result is
  shown but deliberately not stored, so the baseline survives untouched.

## The seven buckets

A PR sits in exactly one, resolved first-match-wins:

1. **Awaiting me** — a review is requested of you and you have not answered
2. **I blocked it, and it moved** — you requested changes and they have pushed
   since, so they are waiting on you and do not know it
3. **Mine, ready to land** — approved, nothing blocking
4. **Mine, needs work** — changes requested, checks failing, or conflicting
5. **Mine, waiting** — awaiting review, or checks still running
6. **I blocked it, unchanged** — still on them
7. **Ambient** — you approved, commented, or were only mentioned

## What it reports as a change

`joined`, `left`, `pushed-while-blocked`, `retargeted`, `review-requested`,
`verdict`, `checks`, `merge`, `ready`, `bucket`. A row shows only its most
significant change; all of them are stored.

Two are only possible because state is kept:

- **`retargeted`** — GitHub silently moves a PR's base branch when a stack rebases
  and marks it in no way at all. The only way to see it is to compare against a
  previous sync.
- **`left`** — the scan asks for open PRs, so a merged one simply stops appearing.
  Nothing in a single scan distinguishes "merged" from "never matched".

A bare push is deliberately *not* reported unless you are blocking the PR.
Dependency bots push constantly, and an unconditional push axis would report
nothing else.

## Other commands

```bash
bun run scan owner/repo [owner/repo ...]   # headless, ad-hoc, ignores the store
bun run scan owner/repo --json             # raw
bun src/cli.ts --state ./other.db          # use a different store for one run
bun src/cli.ts --help                      # shows the paths actually in force
```

## Development

```bash
bun run check       # typecheck + full test suite
bun run typecheck
bun test
bun run build       # standalone binary at dist/prq
```

`bun run build` produces a ~73 MB self-contained executable; the size is
OpenTUI's native core, not the application.

### Layout

| Path | Holds |
| --- | --- |
| `src/domain.ts` | the state model, and the trust boundary every remote string crosses |
| `src/changes.ts` | pure diff between two syncs |
| `src/query.ts` | the GraphQL for a scan |
| `src/github.ts` | the two searches, unioned |
| `src/store.ts` | SQLite state, migration, atomic commit |
| `src/render.ts` | rows, buckets and the status line, all pure |
| `src/tui.ts` | the OpenTUI dashboard |
| `src/cli.ts` | entry point and sync semantics |
| `CONTEXT.md` | domain glossary — read this before changing the model |
| `.wayfinder/` | the design map: decisions made, and what is still open |

Several choices in the interface are explicitly provisional and marked as such in
`.wayfinder/tickets/`. Before changing behaviour, check whether a ticket already
frames the decision — `map.md` indexes them.

## Privacy

The state database holds private repository names, PR titles, author logins and
URLs. It is written `0600` inside a `0700` directory. `.gitignore` covers `*.db`,
the SQLite WAL sidecars and `.prq/`; if you point `statePath` somewhere else,
check that it is ignored there too.

The tool is **read-only against GitHub**. It never approves, comments, merges or
requests review — the browser link is how you act.
