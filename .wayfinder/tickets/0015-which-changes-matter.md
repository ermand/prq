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

## Implemented as a prototype — 2026-08-07

`src/changes.ts` now reports ten kinds. **The ticket stays open** — this is a
position to react to.

Reported: `joined`, `left`, `pushed-while-blocked`, `retargeted`,
`review-requested`, `verdict`, `checks`, `merge`, `ready`, `bucket`. Each carries
`from` and `to`.

Three decisions worth arguing with:

- **A bare push is not reported.** `pushed-while-blocked` fires only when the
  viewer's changes-request stands. This was the deliberate bot guard: a bump PR
  is pushed often, and an unconditional push axis would report nothing else.
- **A joined PR reports only `joined`**, not every field it happens to hold, so
  first sight of a PR emits one change rather than ten.
- **Significance order** (`KIND_ORDER`) picks a single headline per row:
  review-requested → pushed-while-blocked → retargeted → joined → left →
  verdict → ready → merge → checks → bucket. All changes are stored; only the
  headline is shown.

**A defect found by running it, not by tests.** `mergeable` is computed lazily by
GitHub: a first sync of 29 real PRs returned `UNKNOWN` for 19 of them, and a
second sync seconds later reported 19 spurious `merge` transitions plus 4
consequent `bucket` moves. The rule now is that **learning a previously unknown
value is not a change** — a merge transition with `unknown` on either side is
suppressed, and the bucket comparison substitutes the known value so a bucket
move driven purely by that resolution does not fire either. Three consecutive
syncs now report zero changes. `checks: none` is deliberately *not* treated this
way: it means "no CI configured", which is stable, not pending.

Still open: whether ten kinds is too many, whether `bucket` is the honest unit
rather than the field-level axes, and whether the report should differ from the
dashboard for bot PRs.
