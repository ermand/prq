# Scan strategy, measured

Live benchmark run 2026-08-04 against the GitHub GraphQL API with the token from
`gh auth token`, account **ermand**. Read-only. Every PR node carried the full
taxonomy settled in [0005](../tickets/0005-review-state-taxonomy.md): verdict,
viewer standing, opinionated reviews with commit oids, readiness, lifecycle,
stack membership.

Repo set — 10 repos chosen to span realistic and pathological open-PR counts:
`cli/cli`, `charmbracelet/bubbletea`, `oven-sh/bun`, `denoland/deno`,
`anomalyco/opentui`, `charmbracelet/lipgloss`, `cli/go-gh`,
`charmbracelet/bubbles`, `sst/opencode`, `vercel/turborepo`.

## Summary

- **Page size 5 is strictly worse than page 50.** Identical output, 2.2–2.9×
  the wall clock, 10× the rate-limit cost. There is no compensating benefit: the
  ~10s execution budget is per *query*, and a single repo at 100 nodes returns in
  5.42s well inside it.
- **"Page every repo until finished" does not survive a big repo.** The 10-repo
  set took **323s at page 50, concurrency 5** — 5698 PRs, 119 rounds, cost 119.
  `oven-sh/bun` alone has **3773 open PRs**: 76 rounds, 323s. It is the whole
  scan.
- **`search` does the entire job in one query.** Cross-repo natively, no
  aliasing, **cost 1**, and it carries the full taxonomy including `stack` and
  `stackEntry`. 50 PRs across all 10 repos in **3.57s**.
- **Server-side relevance filtering is free.** `involves:@me`,
  `review-requested:@me` and `author:@me` all resolve in **0.5–0.8s at cost 1**.
- **The choice is not a paging strategy, it is a scope decision.** Full coverage
  costs ~90× the time and 119× the rate-limit budget of a filtered search, to
  surface thousands of PRs that are by construction none of your business.

## Page size, single repo (`cli/cli`, 65 open PRs, fully paged)

| Page size | Rounds | Cost | Wall clock |
| --- | --- | --- | --- |
| 5 | 13 | 13 | 15.13s |
| 25 | 3 | 3 | 7.43s |
| 50 | 2 | 2 | 6.58s |
| 100 | 1 | 2 | 5.42s |

## Full pagination, 10 repos, concurrency 5

**Page size 50** — 5698 PRs, 119 rounds, cost 119, **323.15s**, 0 errors.

| Repo | PRs | Rounds | Wall clock |
| --- | --- | --- | --- |
| `cli/go-gh` | 17 | 1 | 1.63s |
| `vercel/turborepo` | 13 | 1 | 3.45s |
| `charmbracelet/lipgloss` | 72 | 2 | 4.93s |
| `cli/cli` | 65 | 2 | 6.02s |
| `charmbracelet/bubbletea` | 94 | 2 | 6.21s |
| `charmbracelet/bubbles` | 106 | 3 | 8.60s |
| `anomalyco/opentui` | 115 | 3 | 9.65s |
| `denoland/deno` | 300 | 6 | 19.15s |
| `sst/opencode` | 1143 | 23 | 81.33s |
| `oven-sh/bun` | 3773 | 76 | **323.14s** |

**Page size 5** — same repos, aborted during `oven-sh/bun`. Every completed repo
was 2.2–2.9× slower for identical output:

| Repo | Page 50 | Page 5 | Ratio |
| --- | --- | --- | --- |
| `cli/cli` | 6.02s | 13.11s | 2.2× |
| `charmbracelet/bubbletea` | 6.21s | 15.48s | 2.5× |
| `cli/go-gh` | 1.63s | 4.80s | 2.9× |
| `charmbracelet/lipgloss` | 4.93s | 12.43s | 2.5× |
| `charmbracelet/bubbles` | 8.60s | 17.61s | 2.0× |
| `anomalyco/opentui` | 9.65s | 25.19s | 2.6× |
| `denoland/deno` | 19.15s | 55.37s | 2.9× |
| `sst/opencode` | 81.33s | 201.80s | 2.5× |

## Single `search` query across all 10 repos

Query shape: `is:pr is:open repo:… repo:… <filter>`, `type: ISSUE`, `first: 50`,
with the full taxonomy selected inside `... on PullRequest`.

| Filter | `issueCount` | Returned | Cost | Wall clock |
| --- | --- | --- | --- | --- |
| `involves:@me` | 0 | 0 | 1 | 0.84s |
| `review-requested:@me` | 0 | 0 | 1 | 0.62s |
| `author:@me` | 0 | 0 | 1 | 0.53s |
| none | 4555 | 50 | 1 | 3.57s |

The zero counts are correct — this account is not involved in those OSS repos.
They demonstrate the cost profile, not an empty dashboard.

`stack` and `stackEntry` select inside the search result fragment without error,
so nothing is given up by using `search` over per-repo `pullRequests`.

## Search qualifier semantics

**`involves:` does not include review requests.** This is the load-bearing
correction: a single `involves:@me` query would miss most of the PRs actually
waiting on you. `involves:` is `author` OR `assignee` OR `mentions` OR
`commenter` — a requested reviewer who has not yet said anything matches none of
those.

Measured across `cli/cli`, `charmbracelet/bubbletea` and `denoland/deno`, open
PRs only. The last two columns count set members present in that qualifier but
**absent** from `involves:`.

| User | `involves:` | `review-requested:` | `reviewed-by:` | rr ∖ inv | revBy ∖ inv |
| --- | --- | --- | --- | --- | --- |
| `williammartin` | 14 | 32 | 7 | **27** | 0 |
| `babakks` | 22 | 38 | 4 | **22** | 0 |
| `jtmcg` | 1 | 0 | 0 | 0 | 0 |
| `heaths` | 3 | 0 | 1 | 0 | 0 |
| `andyfeller` | 0 | 0 | 0 | 0 | 0 |

- **`review-requested:` must be its own query.** Search qualifiers are ANDed;
  there is no way to OR two of them in one query.
- **`reviewed-by:` is redundant.** Zero escapes from `involves:` across all five
  users — submitting a review makes you a commenter.
- **`team-review-requested:<org>/<team>` is accepted** as a qualifier (no error,
  count 0 for a guessed team). Review requests routed to a team are therefore
  reachable, but only if the team slug is known.
- **`sort:updated` is accepted** and returned 64 for open `cli/cli` PRs.

## Repo scope scales

`repo:` qualifiers were accepted at 10, 20, 30, 40 and 60 occurrences — up to a
1279-character query — with no length or operator-count error. Scoping a search
to a long saved repo list is not a constraint.

## Open gaps

- GitHub's search API caps total results at 1000 regardless of paging. Untested
  here, and unreachable in practice once the viewer filters are applied.
- All repos sampled are large public OSS. A realistic private work repo with a
  handful of open PRs was not measured and will be far cheaper by every metric.
- Whether `search` honours private-repo visibility identically to per-repo
  queries was not verified.
- Whether an approval submitted with no comment body still registers as
  `commenter` was not directly constructed — inferred from 0 escapes across 12
  `reviewed-by:` results.
- Team slugs for `team-review-requested:` cannot be discovered from the repo
  list alone.
