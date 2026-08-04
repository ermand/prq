---
id: 0006
title: Language and TUI framework
parent: map
type: grilling
status: open
assignee: ~
blocked_by: [0003]
---

## Question

Which language and which TUI framework does this tool get built in?

Decide, given the tradeoffs laid out by *Viable TUI stacks for a 2026 terminal
app*:

- The language, weighed against what the driver actually maintains comfortably —
  a tool you can't fix at 6pm on a Friday is worse than a slower one you can.
- The TUI framework, and whether its list/tree primitives fit a grouped,
  collapsible PR list or need fighting.
- How the tool is installed and updated on this machine.
- Whether `gh` is shelled out to or the API is called directly with the token,
  following whatever *What PR data gh can return, and what a scan costs*
  measured. Note this determines whether `gh` is a hard runtime dependency.
- Whether the answer changes if GitLab is later added behind the provider seam.

This is a one-way-ish door and the result is surprising without context, so
write an ADR under `docs/adr/` recording the alternatives and why they lost.
