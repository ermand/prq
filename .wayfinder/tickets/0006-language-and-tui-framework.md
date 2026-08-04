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

## Direction from the driver

Bun + OpenTUI (<https://opentui.com>). Captured 2026-08-04.

Verified live the same day, since the survey's framing undersold it:
`anomalyco/opentui` is **v0.5.1, published 2026-08-04** — 12,888 stars, 309 npm
versions, not archived. A TypeScript API over a native Zig core with a C ABI;
Yoga-powered flexbox; `Text`, `Box`, `Input`, `Select`, `ScrollBox`, `Code`,
`Diff` components; tree-sitter syntax highlighting; React and Solid bindings;
built-in focus and keyboard handling. It powers OpenCode in production. `ScrollBox`
plus flexbox covers the grouped-list requirement without a first-class tree.

Two costs to acknowledge rather than discover later:

- **Pre-1.0 with heavy churn** — 309 versions, 208 open issues, minor releases
  days apart (v0.4.5 on 2026-07-17, v0.5.0 on 2026-08-03, v0.5.1 on 2026-08-04).
  Expect breaking changes; pin the version.
- **Startup and size** — 135.6ms time to first frame on Bun (vs 21.6ms for
  Bubble Tea), and a 70MB compiled binary. Acceptable for a tool opened a few
  times a day; worth re-examining if it turns out to be opened constantly.

Still to settle here: whether the scan hits the API directly with `gh auth token`
or shells out to `gh` (0001 measured them indistinguishable, but only a direct
call reaches `stack`), how the tool is installed, and the ADR.
