---
id: 0003
title: Viable TUI stacks for a 2026 terminal app
parent: map
type: research
status: closed
assignee: Main
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

## Resolution

Findings: [0003-tui-stack-landscape.md](../research/0003-tui-stack-landscape.md).
Five candidates surveyed live — Go + Bubble Tea v2, Rust + Ratatui, Bun +
OpenTUI, TypeScript + Ink, Python + Textual — with hello-worlds built and
measured locally. `tview` is stalled. **No winner picked; that is
*Language and TUI framework*.**

**OSC 8 hyperlinks split the field.** Lipgloss `Style.Hyperlink()`, OpenTUI
`link()`, `ink-link` and Textual/Rich all emit them — confirmed by capturing raw
PTY bytes. **Ratatui does not**, and its issue #1028 was still blocked on
Crossterm as of 2026-08-02. Since a clickable PR link is in the destination,
this is close to disqualifying for Rust.

**Only Textual ships first-class Tree and Collapsible widgets.** Everywhere else
a grouped, collapsible list is hand-rolled.

**Time to first painted frame** under a 120×40 PTY: Ratatui 3.4ms, Bubble Tea
21.6ms, Ink compiled 55.5ms, Ink on Bun 75.3ms, OpenTUI on Bun 135.6ms, Textual
255.9ms, OpenTUI compiled 321.4ms. **Binary sizes**: Rust 743KB, Go 5.0MB, Ink
62MB, OpenTUI 70MB.

**Sharp edges found:** Charm v2 has moved to `charm.land/*` import paths;
`ratatui` 0.30 needs rustc 1.88 against the 1.84.1 installed here; OpenTUI is
Bun-only (Node FFI fails) and has moved to `anomalyco/opentui`; `ink-spinner` has
been stale since 2023; Bun has built-in TOML import.

**`gh-dash` is the closest existing analogue** — a PR dashboard built on Bubble
Tea v2. Worth reading before designing the layout, and worth asking whether it
already does this job.
