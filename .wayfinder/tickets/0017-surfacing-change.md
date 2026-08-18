---
id: 0017
title: How change surfaces in the interface
parent: map
type: prototype
status: open
assignee: ~
blocked_by: [0015]
---

## Question

The tool knows what changed since the last sync. Where does the driver see it?

The seven relevance buckets in [0007](./0007-relevance-buckets-and-sort.md) answer
"what should I do next". Change is a second dimension over the same rows, and it
does not obviously belong in the same structure. Make rough ASCII mockups of at
least three treatments and pick one:

- **A marker on the row.** The buckets stay exactly as they are; changed rows gain
  a glyph or colour. Smallest change, and change becomes something you notice
  rather than something you go and look at.
- **A bucket at the top.** "Changed since last sync" outranks *Awaiting me*.
  Loudest, but it fights the bucket model — a row would have to leave the bucket
  that says what to do with it.
- **A separate view.** A keypress swaps the dashboard for a change log of the last
  sync. Keeps the two dimensions apart; costs a mode.
- **Per-row detail.** Change shown only when a row is selected, in a detail pane.
  Quietest, and invisible until asked.

Show the awkward cases in each: a PR that changed in several ways at once; a PR
that left the set entirely and so has no row to mark; a stack where one member
moved; a first sync where everything or nothing is new; and a sync dominated by
eight Dependabot pushes.

Grounded in whichever axes *Which changes are worth reporting* declares
reportable. Note that [0011](./0011-tui-layout-and-keys.md) is still open, so the
layout this lands in is itself unsettled — if that ticket resolves first, respect
it; if not, this prototype informs it.

## Implemented as a prototype — 2026-08-07

**The ticket stays open**, and this is the treatment most in need of a real
opinion, because it was chosen for being the smallest rather than the best.

Shipped: **the marker on the row**, the first option listed above. The seven
buckets are untouched; a changed row gains a coloured `[label]` before its meta
column, showing only the headline change. The header carries `N changed`, and
`c` toggles a changed-only filter which reads `changed only` in the status line.

Verified on real data: a rewound baseline produced `[retargeted]` on one row and
`[ci]` on another, both visible in the dashboard, and `c` narrowed 29 PRs to
those 2.

What this treatment does **not** solve, and what a real decision should weigh:

- **A PR that has left the set has no row to mark.** `left` changes are recorded
  in the store and counted in the header, but are invisible in the list — the one
  case a marker fundamentally cannot express. This is the strongest argument for a
  separate view or a change log.
- Only the headline shows, so a PR that moved five ways looks like it moved once.
- Nothing distinguishes "changed since the last sync" from "changed a while ago"
  once several syncs have passed, because only the newest sync's changes are read.
- A sync dominated by Dependabot pushes was not exercised, since the bot guard
  means bumps rarely produce changes at all.
