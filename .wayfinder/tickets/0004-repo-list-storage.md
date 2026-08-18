---
id: 0004
title: Where the saved repo list lives and how it is edited
parent: map
type: grilling
status: open
assignee: ~
blocked_by: []
---

## Question

How does a repo get onto the list, and where does that list live?

"Save a list of repos" is the tool's only piece of persistent user state, so its
shape sets the tone for everything else. Resolve:

- File location and format. XDG config dir versus `~/.config/<tool>`, and TOML
  versus YAML versus JSON.
- What a repo entry *is*. A bare `owner/name` string, or a record with room for
  a display name, a group or team, a per-repo enable flag, an author filter.
- Whether repos can be grouped, and whether grouping is a display concern or a
  scan-scope concern.
- How the list is edited: hand-edited file only, a `<tool> add owner/repo`
  subcommand, in-TUI add and remove, or some combination. Whether in-TUI edits
  write back to the same file a human hand-edits, and how comments survive that.
- Whether provider is explicit per entry or inferred from the host, given the
  provider seam being designed for GitLab later.
- Whether anything else belongs in the same file — the identity used for "is
  this mine", refresh interval, theme — or whether config and repo list are
  separate concerns in separate files.

## Direction from the driver

YAML config file. Captured 2026-08-04; not yet a resolution — the remaining
sub-questions (what a repo entry contains, grouping, how it is edited, whether
provider is explicit) are still open.

One fact to weigh when this is resolved: if the stack is Bun, TOML import is
built in and YAML needs a dependency.

## Implemented as a prototype — 2026-08-07

**The ticket stays open.** What the config carries today:

- `repos:` — a flat list of `owner/name` strings, deduplicated, validated at both
  the loader and the query sink. No grouping, no per-repo flags, no display name.
- `statePath:` — added on request so the state database can sit beside a project
  instead of under `~/.local/state`. Absent means the XDG default. A **relative**
  path is resolved against the working directory, which is deliberately the
  opposite of how `XDG_STATE_HOME` is treated — a relative value there is ignored,
  because it would silently write under whatever directory you happened to be in,
  whereas here that is the entire point. A leading `~` expands. `--state <path>`
  overrides it for one run.
- `cacheTtlMinutes:` is **gone** — sync is explicit, so nothing expires. The
  parser still tolerates the key so an old config does not start failing.

No in-TUI editing, and no `prq add owner/repo`. The file is hand-edited; `prq
init` writes a commented example.

One consequence worth deciding on: the store holds private repo names and PR
titles, so a project-local `statePath` needs `.gitignore` coverage. The repo now
ignores `*.db`, its WAL sidecars and `.prq/`, but a *user* pointing `statePath` at
someone else's project gets no such protection. Whether the tool should refuse to
write inside a git working tree that does not ignore it is an open question.
