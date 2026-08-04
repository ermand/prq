---
id: 0013
title: How many open PRs a scan actually fetches, and how it pages
parent: map
type: grilling
status: open
assignee: ~
blocked_by: []
---

## Question

The destination says "every open PR in the tracked repos". Measurement says that
is not free, and may not be wanted. What does a scan actually fetch?

*What PR data gh can return, and what a scan costs* established a ~10 second
server-side GraphQL execution budget: exceed it and GitHub returns an HTML 502.
A rich selection — review state, check rollup, stack — sustains roughly 100 PR
nodes per query. Meanwhile `golang/go` has 502 open PRs and `cli/cli` has 63.
One query cannot see everything, and cursor-paging a 500-PR repo would cost many
round trips to surface PRs that are, by construction, none of your business.

Resolve:

- Whether "every open PR" is honestly what you want, or whether the real want is
  every open PR *that could plausibly concern you*. If the latter, say what the
  server-side filter is — `involves:@me`, `review-requested:@me`, `author:@me`,
  organisation membership, or a per-repo setting.
- Whether a per-repo cap exists, what it is, and what the UI says when a repo is
  truncated. A silently incomplete dashboard is worse than an honest one.
- Whether to page with cursors at all, and if so eagerly during the scan or
  lazily when a repo is expanded.
- Whether the scan is one query or several. Sharding across queries keeps each
  under the budget and lets a slow repo fail alone rather than taking the scan
  with it — weigh that against N round trips.
- Whether a two-pass shape is worth it: a cheap wide pass for identity and stack
  membership, then a rich pass only for the PRs actually shown. The lean
  selection measured about twice as cheap as the rich one.
- What the client does with the two failure shapes: an HTML 502 that will not
  parse as JSON, and an HTTP 200 carrying partial `data` plus a per-field
  `errors[]` array.

Grounded in [0001b-graphql-query-budget.md](../research/0001b-graphql-query-budget.md).
Note the sampled repos were all large public OSS; if the real repo list is a
handful of private repos with a few open PRs each, most of this pressure
evaporates — establish which world we are in before designing for the hard one.

## Direction from the driver

"Scan 5 at a time and cache them for 15 mins." Captured 2026-08-04.

Needs disambiguating before it can be a resolution: **5 repos concurrently, or 5
PRs per repo?** The measurements bear on each differently — 10 repos × 5 PRs with
a rich selection ran in 8.14s at cost 1, comfortably inside the ~10s budget, so
either reading is affordable.

The 15-minute cache is clear and settles most of *Refresh, caching, and
staleness*.

Left open: what the UI says when a repo has more open PRs than were fetched.
`cli/cli` has 63 open; a 5-per-repo cap would show 5 with no indication the other
58 exist.
