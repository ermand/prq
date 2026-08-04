# The GraphQL execution budget, and what actually breaks a multi-repo scan

Parent-session live verification, run 2026-08-04 against `gh` 2.96.0 authenticated
as **ermand**. This file exists because a spot-check of two load-bearing claims in
[0001](./0001-gh-pr-data-and-scan-cost.md) and the conclusions drawn from them did
not reproduce, and the real mechanism turned out to be different — and more
useful.

All commands were read-only `gh api graphql` calls. Repos sampled: `cli/cli`,
`golang/go`, `rust-lang/rust`, `nodejs/node`, `oven-sh/bun`, `denoland/deno`,
`vercel/next.js`, `facebook/react`, `microsoft/TypeScript`, `charmbracelet/bubbletea`.

## Summary

- **The failure mode is a ~10 second server-side execution budget.** Every query
  that failed took 10.7–10.9s and returned an **HTML `502 Bad Gateway`**, not a
  GraphQL error document. Every query that succeeded returned in ≤10.3s. Node
  count and field expense matter only insofar as they push execution past the
  budget.
- **`mergeStateStatus` is not the culprit.** It is expensive — adding it to a
  single-repo `first: 30` query moved 3.48s → 5.42s, reproducibly (5.51s on
  repeat) — but a 10-repo `first: 20` query failed identically *with and without*
  it. Excluding the field is a latency optimisation, not a correctness
  requirement.
- **A "rich" selection (review state + check rollup + stack) sustains ~100 PR
  nodes per query.** 10 repos × 5 = 50 nodes in 8.14s (cost 1); 10 repos × 10 =
  100 nodes in 10.17s (cost 2); 5 repos × 20 = 100 nodes in 10.30s (cost 2). The
  shape of the split does not matter, only the total.
- **A "lean" selection (title, url, author, dates, draft, reviewDecision, stack)
  is roughly twice as cheap.** 10 repos × 10 = 100 nodes in 4.96s at cost 1.
  It still fails at 500 nodes.
- **Rate limit is a non-issue; wall-clock is the whole constraint.** Every
  successful query cost 1–2 points against a 5000/hr GraphQL budget. Nothing in
  this workload will ever approach the limit.
- **A 502 arrives as HTML.** A client that assumes a JSON body will throw on
  parse rather than surface a useful error. Partial failures are the *other*
  shape: HTTP 200 carrying `data` plus a per-field `errors[]` array — one
  10-repo `first: 20` run returned exactly that at cost 4.
- **Consequence for the destination.** A single query cannot return every open PR.
  `golang/go` alone reports 502 open PRs and `cli/cli` 63; a rich scan of 10 repos
  tops out near 100 PRs total. This is not a tuning detail — it contradicts
  "show every open PR in the tracked repos", and is now ticketed as
  *How many open PRs a scan actually fetches, and how it pages*.

## Measurements

Single repo, `cli/cli`, `first: 30`:

| Selection | Wall clock | Cost | Result |
| --- | --- | --- | --- |
| `mergeable`, `reviewDecision`, `latestReviews(10)`, check rollup | 3.48s | 1 | ok |
| the same plus `mergeStateStatus` | 5.42s / 5.51s | 1 | ok |
| `reviews(first: 50)` with `commit { oid }` plus check rollup | 1.52s | 1 | ok |

Ten aliased repos, rich selection (`mergeable`, `reviewDecision`, `stack`,
`stackEntry`, `latestReviews(10)`, check rollup):

| Shape | Nodes | Wall clock | Cost | Result |
| --- | --- | --- | --- | --- |
| 10 × `first: 5` | 50 | 8.14s | 1 | ok |
| 10 × `first: 10` | 100 | 10.17s | 2 | ok |
| 5 × `first: 20` | 100 | 10.30s | 2 | ok |
| 10 × `first: 20` | 200 | 10.85s | — | **502 HTML** |
| 10 × `first: 20` + `mergeStateStatus` | 200 | 8.98s | 4 | **HTTP 200, partial `data` + `errors[]`** |
| 10 × `first: 50` | 500 | 10.87s | — | **502 HTML** |

Ten aliased repos, lean selection (`title`, `url`, `isDraft`, `createdAt`,
`updatedAt`, `author`, `baseRefName`, `reviewDecision`, `stack`, `stackEntry`):

| Shape | Nodes | Wall clock | Cost | Result |
| --- | --- | --- | --- | --- |
| 10 × `first: 10` | 100 | 4.96s | 1 | ok |
| 10 × `first: 50` | 500 | 10.78s | — | **502 HTML** |
| 10 × `first: 100` | 1000 | 10.85s | — | **502 HTML** |

## Stack fields, verified live

`stack` and `stackEntry` select inside a `repository.pullRequests` connection and
return real values — the claim [0002](./0002-stacks-api-shape.md) could only
support from documentation:

```
cli/cli #14013 → stack { number: 14025, size: 6, baseRefName: "trunk" }, stackEntry { position: 5 }
```

Of 30 open `cli/cli` PRs sampled, 2 carried a stack; 30 open `golang/go` PRs
carried none. Absent membership omits the key entirely rather than returning
`null`, matching 0002.

Observed enum values across the sample: `reviewDecision` ∈ {`APPROVED`,
`CHANGES_REQUESTED`, `REVIEW_REQUIRED`, `null`}; `mergeable` ∈ {`MERGEABLE`,
`CONFLICTING`}. The check rollup arrives nested as
`commits(last: 1).nodes[0].commit.statusCheckRollup.state`.

## Open gaps

- The 10s budget is inferred from the correlation between elapsed time and
  failure across 12 runs, not from documentation. It was not confirmed against a
  published GitHub limit, and it may be a shared-tier value rather than a fixed
  one.
- Cursor pagination was not benchmarked. Whether fetching all 502 open
  `golang/go` PRs via `after:` cursors is tolerable is unmeasured, and is the
  central unknown for the scan-breadth ticket.
- All sampled repos are large public OSS. Private repos with a handful of open
  PRs — the realistic workload — were not measured and will be far cheaper.
- Whether the 502 is retryable, and whether an immediate retry of an identical
  query succeeds, was not tested.
