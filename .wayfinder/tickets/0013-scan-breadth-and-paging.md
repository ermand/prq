---
id: 0013
title: How many open PRs a scan actually fetches, and how it pages
parent: map
type: grilling
status: closed
assignee: Main
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

## Resolution

Benchmark: [0013-scan-strategy-benchmark.md](../research/0013-scan-strategy-benchmark.md).

**A scan is two `search` queries, not a walk over the repo list.** The saved
repos become the *scope* of a search — `repo:owner/name` qualifiers — rather than
a list to iterate and page. Option (a).

### The two queries

Both scoped `is:pr is:open <repo qualifiers>`, unioned by PR node id:

1. `review-requested:@me` — the review queue.
2. `involves:@me` — authored, assigned, mentioned, or commented on.

**Two queries are required, not one.** `involves:` is `author` OR `assignee` OR
`mentions` OR `commenter` and **does not include review requests** — measured, it
missed 27 of 32 review requests for one user and 22 of 38 for another. Since
search qualifiers are ANDed with no way to OR them, the queue needs its own
query. A single `involves:@me` scan would have silently omitted most of the PRs
the tool exists to surface.

`reviewed-by:@me` is **not** needed — zero escapes from `involves:` across five
users, because submitting a review makes you a commenter.

### Cost

Cost 1 per query, 0.5–0.8s each, runnable in parallel. Against the rejected
design — page every repo to exhaustion — which measured **323s, 119 rounds, cost
119** over 10 repos, dominated entirely by `oven-sh/bun`'s 3773 open PRs. Roughly
90× faster at 1/119th the rate-limit cost, and it does not degrade as the repo
list grows.

`stack` and `stackEntry` select inside the search result fragment, so nothing is
given up versus per-repo `pullRequests`.

### Paging

`first: 100` with cursor paging if `hasNextPage`. In practice one page: these
filters return tens of PRs, not thousands. **Page size 5 is rejected** — measured
2.2–2.9× slower and 10× the rate-limit cost for identical output, because the
~10s execution budget is per query, not per repo.

### Truncation

Moot. The filters define the result set rather than truncating it, so there is no
"showing 50 of 4555" problem and no honesty gap to paper over. The dashboard's
scope is now "PRs that concern me in these repos", which is what the relevance
grouping already assumed.

### Concurrency

Two queries in parallel. Per-repo concurrency is gone along with per-repo
queries.

### Failure handling

Unchanged in kind but far smaller in surface: an HTML 502 that will not parse as
JSON, and an HTTP 200 carrying partial `data` plus a per-field `errors[]` array.
With two cheap queries, retrying a failed one is trivial. If one of the two
fails, the union is incomplete and must be reported as such rather than rendered
as if whole.

### Repo scope scales

`repo:` qualifiers were accepted up to 60 occurrences and a 1279-character query
with no error, so a long saved list is not a constraint.

### Deliberately not solved here

Review requests routed to a **team** need `team-review-requested:<org>/<team>`,
which is accepted as a qualifier but requires knowing team slugs. That is config
surface for *Where the saved repo list lives and how it is edited*, and it is now
on the map's fog.
