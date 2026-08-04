---
id: 0001
title: What PR data gh can return, and what a scan costs
parent: map
type: research
status: closed
assignee: Main
blocked_by: []
---

## Question

What can we actually observe about an open PR through `gh`, and what does
scanning a list of repos cost in requests and wall-clock time?

Establish, against the real authenticated CLI (`gh` 2.96.0, account **ermand**):

- The full set of `gh pr list --json` fields, and which of them carry:
  review decision, individual reviews and their authors/states, requested
  reviewers, CI check rollup, mergeable/conflict state, draft flag, timestamps,
  author, labels, base and head branch.
- Whether "someone else has already reviewed" and "I have already reviewed" are
  derivable from a list query alone, or need a per-PR follow-up. Note that a
  reviewer can review more than once — establish whether the API gives latest
  state per reviewer or a full history.
- Whether a single GraphQL query can span several repos at once, and if so
  whether `gh api graphql` can issue it. Compare against N sequential
  `gh pr list` invocations.
- The request cost and measured wall-clock time of one scan of ~10 repos, both
  ways. Include rate-limit headroom under a `repo`-scoped token.
- Process cost: is shelling out to `gh` per repo acceptable, or does the volume
  argue for hitting the API directly with the token `gh auth token` yields?

Deliver concrete evidence — real command invocations and real output shapes, not
documentation summaries. Redact repo and org names if they are private.

## Resolution

Findings: [0001-gh-pr-data-and-scan-cost.md](../research/0001-gh-pr-data-and-scan-cost.md)
(the scout's survey, 470 lines) and
[0001b-graphql-query-budget.md](../research/0001b-graphql-query-budget.md)
(parent-session live verification, which corrected two of the scout's
conclusions).

**Fetch with one hand-written GraphQL query over aliased repositories, not N
`gh pr list` shell-outs.** Measured on 10 repos: sequential `gh pr list` 82.06s,
fully concurrent 11.35s, single aliased GraphQL query 7.9–8.9s. `gh` process
overhead is 0.02s warm — shelling out is not what costs; round trips are, and
per-repo fan-out never drops below one round trip per repo. A `curl` control
using `gh auth token` was indistinguishable from `gh api` (8.0–9.2s), so the
token can be used directly without penalty.

**`gh pr list --json` offers 47 fields and none is stack-related** — the one
field the destination needs that the CLI cannot supply. It is reachable in the
same GraphQL query, so the hand-written query wins on capability as well as
speed.

**Review state is derivable from a list query.** `latestReviews` is
latest-per-author, minus the PR author's own reviews, minus reviewers with a
pending re-request (61 PRs analysed; all 24 mismatches explained by the
self-review rule; 0/180 overlap between `reviewRequests` and `latestReviews`).
**Stale reviews need `reviews[].commit.oid` compared against `headRefOid`** —
`latestReviews` omits `commit`, so a superseded review is invisible through it.
Selecting `reviews` instead costs nothing measurable and buys the stale flag.

**The real failure mode is a ~10s server-side execution budget, not node count
and not `mergeStateStatus`.** Every failed query took 10.7–10.9s and returned an
**HTML 502**; every success returned in ≤10.3s. A rich selection sustains ~100 PR
nodes per query, a lean one about twice that. `mergeStateStatus` is merely
expensive (3.48s → 5.42s single-repo), not disqualifying. Partial failure has a
second shape: HTTP 200 carrying `data` plus a per-field `errors[]` array, which
a status-code-only client renders as silent holes.

**Rate limit is a non-issue.** Every successful scan cost 1–4 points against
5000/hr. Wall clock is the entire constraint.

**Consequence:** a single query cannot return every open PR — `golang/go` alone
has 502 open. This contradicts the destination's wording and is now ticketed as
*How many open PRs a scan actually fetches, and how it pages*.
