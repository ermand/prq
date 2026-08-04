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
