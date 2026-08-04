---
id: 0003
title: Viable TUI stacks for a 2026 terminal app
parent: map
type: research
status: open
assignee: ~
blocked_by: []
---

## Question

What are the credible language + TUI framework combinations for this tool as of
2026, and what does each cost?

The tool is a read-only dashboard: a scrollable, grouped list with detail, colour,
mouse-optional, and clickable hyperlinks. Modest by TUI standards.

For each serious candidate — at minimum Go + Bubble Tea, Rust + Ratatui, and
TypeScript on Bun or Node (Ink, OpenTUI, or whatever has displaced them) —
establish:

- Current maintenance status and release cadence. Flag anything stalled.
- How a grouped/nested list with collapsible sections is expressed, and whether
  a tree is idiomatic or a fight.
- Support for OSC 8 terminal hyperlinks, so a PR URL is clickable rather than
  copy-pasted.
- Distribution: what the user installs, and whether a single self-contained
  binary is achievable.
- Startup time, since this is a tool opened many times a day.
- Ecosystem for the boring parts: config file parsing, async concurrent fetches,
  spinners and progress during a multi-repo scan.

Note the available runtimes on this machine: Bun 1.3.14, Node 24.15.0, Go, Cargo
1.84.1, Python 3.14.6. Do not pick a winner — that decision belongs to
*Language and TUI framework*. Lay out the tradeoffs so it can be made in one
sitting.
