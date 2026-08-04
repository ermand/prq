---
id: 0011
title: TUI layout, panes, and keybindings
parent: map
type: prototype
status: open
assignee: ~
blocked_by: [0006, 0007, 0008]
---

## Question

What is on screen, and what happens when you press a key?

Everything upstream has settled *what* is shown; this settles how it looks and
how it is driven. Build a real prototype in the chosen framework — throwaway,
with fixture data, no live API — and iterate on it live.

Resolve:

- The layout. Single scrolling list, or list plus detail pane. Whether the detail
  pane is always present, toggled, or a full-screen push.
- A single PR row: which fields fit, in what order, and what is dropped first at
  80 columns.
- How each axis from *The PR review-state taxonomy* is encoded — colour, glyph,
  or word — and whether it survives a monochrome terminal.
- The keymap: navigation, expand and collapse, open in browser, copy URL,
  refresh, filter, quit. Whether it is vim-flavoured, arrow-driven, or both.
- Filtering and search: is there a filter line, and does it match repo, author,
  title, or state.
- How the stack treatment chosen in *How a stack renders in a flat PR list*
  actually behaves under a cursor — what does moving down through a collapsed
  stack do.
- Whether the PR link uses an OSC 8 hyperlink, opens via the system opener, or
  both.

The prototype is an asset linked from this ticket, not a foundation to build on.
