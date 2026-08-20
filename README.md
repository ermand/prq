# prq

A terminal dashboard for the pull and merge requests that concern you, across a
saved list of GitHub and GitLab projects — grouped by what you should do next, and
able to tell you what changed since you last looked.

## Setup

```bash
bun install
bun src/cli.ts init      # writes an example config
```

Then edit `~/.config/prq/config.yaml`:

```yaml
github:
  - owner/repo
  - owner/another-repo

gitlab:
  - group/subgroup/project   # nested as deeply as your groups go

# Optional. Omit for ~/.local/state/prq/state.db.
# MUST be absolute if you install prq on your PATH — a relative path resolves
# against the directory you run it from, so a global command would silently create
# a fresh empty database wherever you happen to be.
statePath: /abs/path/to/prq/.prq/state.db
```

Either key may be omitted. Provider is declared by which list an entry sits in,
never inferred from the path — `gitlab-org/gitlab` is two segments, exactly like a
GitHub repo, so depth carries no information.

Authentication is per provider and discovered, not configured: `gh auth login` or
`GITHUB_TOKEN`, and `glab auth login` or `GITLAB_TOKEN`. Each provider reports its
own absence, and one missing credential does not stop the other.

`glab auth login` may store either a long-lived personal access token or an OAuth
one that lasts two hours. `glab` refreshes OAuth tokens on its own API calls but
not when its stored config is merely read, so the token is checked for staleness
and refreshed through `glab` before a scan uses it. Without that, a sync more than
two hours after your last `glab` command failed with a bare `401`.

## Installing

```bash
bun link        # puts `prq` on your PATH
bun unlink      # removes it
```

That symlinks `prq` into bun's global bin directory, pointing at the source. Edits
take effect immediately, with no rebuild — and it is the *faster* option, which is
not the obvious answer. Measured on an M4 Pro, five runs each:

| | startup | size |
| --- | --- | --- |
| `bun src/cli.ts` (linked) | 0.12s | — |
| `bun run build` binary | 0.29s, 1.72s cold | 73 MB |

The standalone binary pays 2.4x the startup to page in 73 MB, and needs rebuilding
after every change. Its one advantage is needing no bun at runtime:

```bash
bun run build            # -> dist/prq, a self-contained binary
cp dist/prq ~/.local/bin # for a machine without bun
```

Because the link points into this checkout, moving or deleting the directory
breaks the command — run `bun link` again from the new location. Whichever you use,
`prq --help` prints the config and state paths actually in force, which is the way
to check what a global install is really reading.

After `bun unlink` your shell may still run the old path from its command hash, so
`prq` appears to survive removal. `hash -r` clears it.

## Running

```bash
prq              # open the dashboard in the terminal
prq web          # open the same board in a browser
prq sync         # sync now, then report what changed
```

Without installing, the same two from inside the checkout:

```bash
bun start        # open the dashboard
bun run web      # open the browser dashboard
bun run sync     # sync now, from the shell
```

**Launch never touches the network.** It reads the last synced state and paints
instantly. Syncing is always something you ask for — press `S` in the dashboard,
or run `prq sync`. That is the whole point: you own the baseline, so a
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

## In the browser

```bash
prq web                       # http://localhost:4177, opens a browser
prq web --port 8080           # somewhere else
prq web --no-open             # do not launch a browser
prq web --state /tmp/scratch.db
```

Same store, same buckets, same rules — `domain.ts` owns the bucket logic, so the
two front-ends cannot disagree about where a PR belongs. React and TanStack Start,
served from `127.0.0.1` only.

It is local by necessity, not modesty. Authentication comes from spawning `gh` and
`glab`, and the store is `bun:sqlite`; a hosted deployment has neither, so it
would need a rewritten transport, a hosted database, stored tokens and a login.

What the browser adds is space. Selecting a row opens a panel with the reviewers,
the stack, the base branch and head, whether your block is stale, and the full
change history for that row — all of it already in the store, none of it costing a
request. The grouping, the filter and the selected row live in the URL, so a
reload or a back button restores the view the terminal forgets on exit.

Each row has two targets that do not overlap. The body selects the row; the `↗`
at the right edge leaves for the forge, in a new tab. It is a real anchor, so
middle-click and cmd-click open a background tab and "copy link address" works.
A PR whose API link failed validation shows `✕` instead, rather than a control
that does nothing.

**Sync is still explicit.** A page load calls a read-only server function; it
never touches the network. The sync button is the only thing that does, and it is
the only write path in the app — every other outbound action is an anchor to the
forge, so read-only is structural rather than a matter of discipline.

Reloading is safe, and slightly better than the TUI: changes are persisted, so a
refresh re-reads the diff instead of losing it.

One caveat worth knowing. If a scan fails, nothing is committed — so those
failures exist only in the sync's reply, and the banner reporting them is cleared
by a reload. The CLI behaves the same way, having printed them once.

### Filters

The text box matches title, repo, author and number, so the pills next to it are
the three things it cannot express:

- **`changed`** — only rows that moved since the last sync. This is the TUI's
  `c`, and it was the one feature the board did not have.
- **`forge`** — taps through `gh`, then `gl`, then off.
- **`no drafts`**

All of them live in the URL alongside the grouping and the selection, so a
filtered board is a link you can send.

## The census

The board answers "what needs me now". It cannot answer "how many pull requests
does this project have" or "who works on it", and not by omission: the scan is
`is:open` and `involves:@me`, so it has never seen a merged pull request or one
belonging to somebody else.

The census is the other axis — every pull request in every configured project,
whatever its state and whoever opened it, kept durably:

```bash
prq census
```

Measured here: 2181 pull requests and 3565 review acts across 20 projects,
2m21s, about 55 rate-limit points of 5000. That cost is why it is a separate
command that you run occasionally, and never something a page load triggers.

It writes its own tables. A census never touches the board's rows, and a sync
never touches the census — one is fast, ego-scoped and destructive, the other is
slow, repo-wide and accumulative. A project that fails is recorded as failed and
its previous history is left alone, for the same reason a partial scan is never
committed.

### Projects

`/repos` lists every censused project with its totals, and one project opens a
page with time-to-merge (median **and** p90 — the median alone hides the tail),
merge rate, review coverage, self-merges, monthly throughput, and its authors and
reviewers ranked.

### People

`/people` is the roster, and a person opens a profile: what they wrote, per
project, and how they review — reviews given against reviews received.

Two things that page does deliberately.

**One human, one profile.** The same person usually has an account per forge. Add
them to `people:` in the config and the profile combines both; otherwise every
login stands alone. Here, `ermand` on GitHub and `ermandduro` on GitLab measured
659 and 156 pull requests separately, and neither number was the truth.

**Bots are separated, not ranked.** `dependabot` has 126 pull requests and
`gemini-code-assist` has 549 review acts, which would place a dependency updater
and an AI reviewer above most of the staff. They are excluded by default and the
roster says how many it is hiding. Detection is by name, not by behaviour:
"reviews constantly and authors nothing" describes `gemini-code-assist`, and it
equally describes a tech lead.

### What these numbers are not

They are counts of pull requests, review acts and lines. One pull request is one
row whether it is a 4000-line generated migration or a one-line fix to a race
condition, and neither forge records a way to tell those apart. The profile page
says so above its own figures. Read it as a record of activity.

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

## What the two providers can and cannot say

The row model carries the richer shape of the two, and each row records how well
its provider filled it — because **capability is per project, not per provider**. A
blocking review is reportable on a paid GitLab project and invisible on a free one,
inside a single scan.

| | GitHub | GitLab |
| --- | --- | --- |
| changes requested | always | paid tiers only |
| "I blocked it, and it moved" | exact, by comparing commits | approximate, by comparing timestamps; sometimes undecidable |
| stacks | one stack, counts merged layers | may belong to several; open layers only, shown `2/4~` |
| "someone mentioned me" | yes | **not expressible** — GitLab has no such filter |

A `~` after a stack position means the count is approximate. An undecidable
"blocked and moved" resolves *toward* action rather than away from it: it is better
to look twice than to leave someone waiting.

GitLab cannot filter by "mentions me" or "commented on it" in either of its APIs,
so its scan fetches the open MRs in your projects and filters locally. That is
affordable because the list is explicit and small.

## Other commands

```bash
prq census                                 # read every project's full history
bun run scan owner/repo [owner/repo ...]   # headless, ad-hoc, ignores the store
bun run scan owner/repo --json             # raw
bun src/cli.ts --state ./other.db          # use a different store for one run
bun src/cli.ts --help                      # shows the paths actually in force
```

## Development

```bash
bun run check       # typecheck (both projects) + full test suite
bun run typecheck   # root tsconfig, then web/tsconfig
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
| `src/census.ts` | the census contract: history rows, identity, bots |
| `src/insights.ts` | every figure on the dashboards, pure and clock-injected |
| `src/providers.ts` | the seam: one operation, two implementations |
| `src/query.ts` | the GraphQL for a GitHub scan and census |
| `src/github.ts` | GitHub — two searches unioned, plus the census walk |
| `src/gitlab.ts` | GitLab — one query, then a local involvement filter |
| `src/store.ts` | SQLite state and census, baselines, migration, atomic commit |
| `src/render.ts` | rows, buckets and the status line, all pure |
| `src/tui.ts` | the OpenTUI dashboard |
| `src/engine.ts` | read the store, sync and diff, or census — no renderer imported |
| `src/cli.ts` | entry point, argument parsing, `prq web`, `prq census` |
| `web/` | the React dashboard: board, projects, people |
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
