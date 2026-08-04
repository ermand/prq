---
id: 0008
title: How a stack renders in a flat PR list
parent: map
type: prototype
status: open
assignee: ~
blocked_by: [0002, 0005]
---

## Question

What does a stack of PRs look like in a list whose organising principle is
relevance, not branch topology?

Stacks and relevance grouping pull against each other: a stack is an ordered
chain that wants to stay together, while relevance grouping wants to scatter its
members across buckets. Resolve by making something concrete to react to.

Build rough ASCII mockups — not working code — of at least three treatments:

- The stack as a single collapsible unit that sits in the bucket of its most
  urgent member, expanding to show the chain in order.
- Members scattered into their natural buckets, each carrying a stack badge
  (`2/4`) and a way to jump to its siblings.
- A separate stacks pane or view, with the main list showing only unstacked PRs.

For each, show what happens to the awkward cases: a stack whose members sit in
different repos, a partially merged stack, a stack where only the bottom PR needs
my review, a four-deep stack next to single PRs, and a stack member whose base
was auto-retargeted.

Ground every mockup in fields *The shape of the GitHub Pull Request Stacks API*
proved actually available. Link the mockups from this ticket as an asset; pick
one treatment as the answer.
