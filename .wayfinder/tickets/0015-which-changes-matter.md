---
id: 0015
title: Which changes are worth reporting
parent: map
type: grilling
status: open
assignee: ~
blocked_by: []
---

## Question

A diff between two syncs can report a great many differences. Which of them does
the driver actually want to be told about?

The state axes are settled in [0005](./0005-review-state-taxonomy.md). Each can
move between syncs, and not all movements are interesting. Resolve which are
reported, and which are merely stored:

- **Joined the set** — a PR that now concerns you and did not before. Almost
  certainly the headline case.
- **Left the set** — merged, closed, or your involvement ended. Note this is only
  observable from history: the scan queries `is:open`, so a merged PR simply
  stops appearing and nothing in a single scan can distinguish "merged" from
  "never matched".
- **Pushed since I blocked it** — `headRefOid` moved while my changes-request
  stood. Already computed live as `staleBlock`, so the diff adds *when* it
  happened rather than *that* it did.
- **Silently retargeted** — `baseRefName` changed under a stack rebase. The whole
  reason a store was reached for: [0002](./0002-stacks-api-shape.md) established
  the API marks this in no other way.
- **Verdict flipped** — approved, then changes requested, or the reverse.
- **A review was requested of me** — distinct from "joined the set", because the
  PR may already have been visible via `involves:@me`.
- **CI went red, or went green.**
- **Became mergeable, or started conflicting.**
- **Draft became ready.**
- **Bucket changed** — a derived movement rather than a field change. Whether
  this is the honest unit of "something happened to this PR", given the buckets
  already encode what matters.

For each: reported, or stored-but-silent. Then settle whether a PR that changed in
several ways reports all of them or only the most significant, and what
significance order that implies.

Weigh the noise. Measured on the driver's real repos, **8 of 14 PRs awaiting
review are Dependabot bumps**, and a dependency bump pushes often. An axis that
fires on every push will be dominated by bots.
