# 0001 — What PR data `gh` can return, and what a scan costs

_All evidence below is real output from `gh` 2.96.0 authenticated as **ermand**
(`gh auth status` → scopes `admin:public_key, delete:packages, gist, read:org, repo, write:packages`),
run 2026-08-04 against public repos. Every timing is measured; the producing command is given
inline. No private repo or org names appear._

## Summary

- **A single `gh pr list --json` call already carries everything the TUI needs except stack
  membership**: `reviewDecision`, `reviews`, `latestReviews`, `reviewRequests`, `statusCheckRollup`,
  `mergeable`, `mergeStateStatus`, `isDraft`, `createdAt`/`updatedAt`, `author`, `labels`,
  `baseRefName`/`headRefName`/`headRefOid`, `url`.
- **"I already reviewed" and "someone else already reviewed" are derivable from the list query
  alone.** No per-PR follow-up is needed. `latestReviews` = latest review per author, **minus the PR
  author's own reviews, minus any reviewer with a pending (re-)review request**. `reviews` is the full
  chronological history (`reviews(first: 100)`, one page, no pagination in list mode).
- **Stale reviews are distinguishable, but only via `reviews`, not `latestReviews`.**
  `reviews[].commit.oid` vs `headRefOid` gives it exactly. `gh`'s `latestReviews` fragment omits
  `commit` and `id` (they deserialise as `""`), so staleness must come from `reviews`.
- **`mergeStateStatus` is the single most dangerous field and should be dropped from the scan.** It
  reproducibly returns HTTP 502/504 on busy repos. Same command, same repo, only that field added:
  base 8.65s/8.35s OK → +`mergeStateStatus` 11.34s/11.38s **both HTTP 504**. On a 10-repo `--limit 50`
  sequential scan it took out 6 of 10 repos; removing it took failures to 1 of 10 and the total from
  88.70s to 62.84s.
- **One GraphQL request can span all repos** via aliased `repository` fields, and `gh api graphql`
  issues it fine. 10 repos × 5 PRs with full review + check data: **cost 3, ~8s, 0 errors**. Cost tracks
  `nodeCount` (≈ nodeCount/100), *not* repo count — page size is the lever, not repo count.
- **Concurrency beats everything about the shell-out cost; the shell-out cost is negligible.** 10 repos
  sequential = **82.06s**; the same 10 fully concurrent = **11.35s**; one GraphQL query = **7.9–8.9s**.
  `gh` process startup is **~0.02s warm** (`gh --version`, mean 0.036s over 10 including a 0.18s cold
  first run). A `curl` control using `gh auth token` on the same GraphQL query ran **8.03–9.24s** —
  statistically identical to `gh api graphql`. **Shelling out is not the bottleneck. Round trips are.**
- **Rate-limit headroom is not a constraint.** REST core 5000/hr, GraphQL 5000 points/hr, and one
  `gh pr list` costs **1 GraphQL point** (measured). A 50-repo scan costs ~50 points → 100 full scans
  per hour.
- **Stack membership is reachable in the same GraphQL round trip** — the one thing `gh pr list --json`
  cannot supply. `stack { number size baseRefName }` and `stackEntry { position }` select cleanly
  inside `repository.pullRequests` and returned live values at cost 1 for 30 PRs.

## Findings

### The full `gh pr list --json` field set at 2.96.0

Command: `gh pr list --json` (no value — `gh` errors out and prints the field list).
Verbatim output:

```
Specify one or more comma-separated fields for `--json`:
  additions
  assignees
  author
  autoMergeRequest
  baseRefName
  baseRefOid
  body
  changedFiles
  closed
  closedAt
  closingIssuesReferences
  comments
  commits
  createdAt
  deletions
  files
  fullDatabaseId
  headRefName
  headRefOid
  headRepository
  headRepositoryOwner
  id
  isCrossRepository
  isDraft
  labels
  latestReviews
  maintainerCanModify
  mergeCommit
  mergeStateStatus
  mergeable
  mergedAt
  mergedBy
  milestone
  number
  potentialMergeCommit
  projectCards
  projectItems
  reactionGroups
  reviewDecision
  reviewRequests
  reviews
  state
  statusCheckRollup
  title
  updatedAt
  url
```

There is **no `stack` or `stackEntry` field** — the gap that forces GraphQL (last section).

### Which field carries which semantic

Measured across 180 open PRs from 10 public repos
(`gh pr list -R <repo> --state open --limit 20 --json <18 fields>`).

| Need | Field | Observed shape / values |
|---|---|---|
| Review decision | `reviewDecision` | `REVIEW_REQUIRED` 131, `APPROVED` 6, `CHANGES_REQUESTED` 1, **`""` (empty string) 42**. Empty ≠ draft: 39 of the 42 empties were non-draft. Empty means "no review required and none requested". Treat `""` as a real state, not null. |
| Individual reviews, author + state | `reviews` | Array, chronological. Per node: `id, author{login}, authorAssociation, body, state, submittedAt, commit{oid}, includesCreatedEdit, reactionGroups`. |
| Latest state per reviewer | `latestReviews` | Same node shape but `id` and `commit.oid` are always `""` — `gh` does not request them. |
| Requested reviewers | `reviewRequests` | `[{"__typename":"User","login":...}]`. 78 entries in the sample, all `User`; `Team` is in the schema but did not occur, so team rendering is **untested**. |
| CI check rollup | `statusCheckRollup` | **A flat array of contexts, not an object.** 4,646 nodes in the sample: 3,599 `CheckRun` + 1,047 `StatusContext`. `CheckRun`: `{name, status, conclusion, startedAt, completedAt, detailsUrl, workflowName}`. `StatusContext`: `{context, state, targetUrl, startedAt}`. **No aggregate state** — fold it yourself. Pending runs carry `conclusion: ""` and `completedAt: "0001-01-01T00:00:00Z"` (Go zero time, not null). |
| Mergeable / conflict | `mergeable` + `mergeStateStatus` | Observed pairs: `MERGEABLE/BLOCKED` 163, `UNKNOWN/UNKNOWN` 12, `MERGEABLE/CLEAN` 4, `CONFLICTING/DIRTY` 1. `UNKNOWN` is common — GitHub computes mergeability lazily. |
| Draft | `isDraft` | boolean. |
| Age | `createdAt`, `updatedAt` | RFC3339 UTC, e.g. `2026-08-04T11:35:04Z`. |
| Author | `author` | `{id, login, name, is_bot}`. Bots: `{"is_bot":true,"login":"app/dependabot"}` — no `id`/`name`, and `app/` is part of the login. |
| Labels | `labels` | `[{id, name, description, color}]`; `color` is bare hex (`"D6393F"`, no `#`). |
| Branches | `baseRefName`, `headRefName`, `headRefOid` | Strings. `baseRefName` ≠ default branch is the cheap stacked-PR heuristic (cli/cli #14062: base `williammartin-route-extension-http`). |
| Link | `url` | `https://github.com/cli/cli/pull/14062` — directly browser-openable, no construction needed. |

### `latestReviews` vs `reviews`: exact semantics

`gh`'s own GraphQL fragments
(<https://raw.githubusercontent.com/cli/cli/v2.96.0/api/query_builder.go>, lines 117–144;
tabs rendered as spaces):

```go
var prReviews = shortenQuery(`
    reviews(first: 100) {
        nodes {
            id,
            author{login},
            authorAssociation,
            submittedAt,
            body,
            state,
            commit{oid},
            reactionGroups{content,users{totalCount}}
        }
        pageInfo{hasNextPage,endCursor}
`)

var prLatestReviews = shortenQuery(`
    latestReviews(first: 100) {
        nodes {
            author{login},
            authorAssociation,
            submittedAt,
            body,
            state
        }
    }
`)
```

Note `latestReviews` requests **no `commit` and no `id`**. That is why they deserialise as `""`.

**Empirical semantics.** I reconstructed latest-per-author from `reviews` and diffed it against
`latestReviews` for all 61 PRs in the 180-PR sample that had ≥1 review:

```
PRs with >=1 review: 61; latestReviews == latest-per-author from reviews: 37; mismatches: 24
{'MISSING:is-PR-author+state=COMMENTED': 24}
```

**All 24 mismatches were the PR author's own self-review being excluded.** Example (cli/cli #14060,
author `sergiou87`):

```
computed: {'sergiou87': ('COMMENTED','2026-08-04T11:25:41Z'), 'copilot-pull-request-reviewer': ('COMMENTED','2026-08-04T11:29:25Z')}
actual  : {'copilot-pull-request-reviewer': ('COMMENTED','2026-08-04T11:29:25Z')}
```

**Second exclusion rule: a pending review re-request suppresses that reviewer's prior review.**
cli/cli #13697, via
`gh pr view 13697 -R cli/cli --json number,author,reviewRequests,reviewDecision,reviews,latestReviews`:

```json
{"n":13697,"prAuthor":"anumol-baby","requested":["BagToad"],"decision":"REVIEW_REQUIRED",
 "reviews":[ "copilot-pull-request-reviewer" COMMENTED x3, "BagToad" COMMENTED 2026-06-22T20:15:50Z,
             "BagToad" COMMENTED 2026-06-22T20:28:38Z, "anumol-baby" COMMENTED x2,
             "copilot-pull-request-reviewer" COMMENTED 2026-07-01T13:15:12Z ],
 "latest":[{"a":"copilot-pull-request-reviewer","s":"COMMENTED","t":"2026-07-01T13:15:12Z"}]}
```

BagToad reviewed twice yet is absent from `latestReviews` — and is sitting in `reviewRequests`.
Corroborated across the whole sample: **in 180 PRs there were 0 cases of a user appearing in both
`reviewRequests` and `latestReviews`.**

**Therefore, from a list query alone:**

- *"I already reviewed"* → `latestReviews[].author.login == me`, with `state` attached. Caveat: if my
  review has been re-requested I vanish from `latestReviews`; use `reviews` for "I have ever touched
  this PR", and `reviewRequests` to detect the re-request.
- *"Someone else already reviewed"* → `latestReviews` non-empty (it already excludes the PR author,
  which is exactly the semantic you want).
- **No per-PR follow-up call is required.**
- Caveat: `reviews(first: 100)` is a single page. `pageInfo` is selected but `gh pr list` does not
  follow it, so a PR with >100 reviews truncates silently.

### Is a stale review distinguishable?

**Yes, from `reviews` only.** Each review node carries `commit{oid}` — the head SHA the review was
submitted against. Compare to the PR's `headRefOid`.

```sh
gh pr list -R cli/cli --state open --limit 60 --json number,headRefOid,reviews \
| jq -c '.[] | select((.reviews|length)>0) | . as $p | {n:.number, head:($p.headRefOid[0:7]),
    revs:[.reviews[] | {a:.author.login, s:.state, c:((.commit.oid//"")[0:7]),
                        stale:((.commit.oid//"") != $p.headRefOid)}]}'
```

Real output (excerpt):

```json
{"n":14060,"head":"25242c1","revs":[{"a":"sergiou87","s":"COMMENTED","c":"292f0c0","stale":true},{"a":"copilot-pull-request-reviewer","s":"COMMENTED","c":"292f0c0","stale":true},{"a":"sergiou87","s":"COMMENTED","c":"292f0c0","stale":true},{"a":"sergiou87","s":"COMMENTED","c":"292f0c0","stale":true},{"a":"copilot-pull-request-reviewer","s":"COMMENTED","c":"25242c1","stale":false}]}
{"n":14017,"head":"3681470","revs":[{"a":"copilot-pull-request-reviewer","s":"COMMENTED","c":"c513704","stale":true},{"a":"copilot-pull-request-reviewer","s":"COMMENTED","c":"3681470","stale":false}]}
{"n":14013,"head":"c47bc92","revs":[{"a":"copilot-pull-request-reviewer","s":"COMMENTED","c":"fed5df9","stale":true}]}
```

Consequence for the spec: **the scan must request both `reviews` and `headRefOid`**, and should derive
"latest per reviewer" itself rather than trusting `latestReviews` — costs nothing extra, buys the stale
flag plus control over the PR-author and re-request exclusions.

This is *reviewer-perceived* staleness (review predates current head), not GitHub's "dismiss stale
reviews" branch-protection semantic, which additionally depends on the protection rule.

### One GraphQL query across several repos

**It works, and `gh api graphql` issues it without ceremony.** Two shapes tested.

**(a) Aliased `repository` fields.** 10 repos as `r0..r9`, each
`pullRequests(states:OPEN, first:5, orderBy:{field:UPDATED_AT, direction:DESC})` over a shared fragment
carrying `number title url isDraft createdAt updatedAt author baseRefName headRefName headRefOid
mergeable reviewDecision labels reviewRequests latestReviews reviews(first:20){…commit{oid}}
commits(last:1){…statusCheckRollup{state contexts(first:10)}}`.

```sh
gh api graphql -f query="$(cat q_both5.graphql)"
```
```json
{"cost":3,"nodes":2600,"errs":0}
```

Response shape is `.data.r0.pullRequests.nodes[]` … `.data.r9…`, each repo carrying `nameWithOwner` and
`totalCount` (real counts observed: cli/cli 63, denoland/deno 327, oven-sh/bun 3773, vercel/next.js 2056,
microsoft/vscode 2370, kubernetes/kubernetes 970, nodejs/node 1084, golang/go 502, rust-lang/rust 1316).
~125 KB of JSON.

**(b) `search`.** `search(query:$q, type:ISSUE, first:50)` with
`q = "type:pr is:open repo:cli/cli repo:denoland/deno …"` (10 `repo:` terms):

```json
{"rateLimit":{"cost":3,"remaining":4832,"limit":5000,"nodeCount":3100},
 "issueCount":12461,"got":50,"hasNext":true,"errs":0}
```

7.36s. **GraphQL `search` does *not* consume the REST search bucket** — `gh api rate_limit` immediately
after showed `search: {limit:30, remaining:30, used:0}` while `graphql.used` had moved.

Trade-off: `search` gives one flat cross-repo list and supports the relevance filters directly —
`review-requested:@me`, `involves:@me`, `author:@me` (measured via `gh search prs`: 3.46s / 2.36s / 1.77s,
30 results each; the GraphQL form of `review-requested:@me` cost **1** and reported `issueCount: 34`).
But it caps at 1000 results, needs cursor pagination, and its default relevance ordering is opaque.
Aliased repositories give per-repo `totalCount` and deterministic ordering.

**Cost model — the important part.** Cost tracks `nodeCount` (≈ `nodeCount/100`), not repo count:

| Query | `first:` | repos | nodeCount | cost | result |
|---|---|---|---|---|---|
| aliased, reviews+rollup | 5 | 10 | 2,600 | 3 | OK |
| aliased, reviews only | 10 | 10 | 4,100 | 3 | OK |
| aliased, no reviews/rollup | 20 | 10 | 4,200 | 4 | OK |
| aliased, reviews+rollup | 8 | 10 | — | — | **HTTP 502** |
| aliased, reviews+rollup | 10 | 10 | 5,200 | 5 | **762 × `RESOURCE_LIMITS_EXCEEDED`** |
| aliased, reviews+rollup+stack | 50 | 10 | 31,000 | 30 | **419 × `RESOURCE_LIMITS_EXCEEDED`** |
| stack fields only | 30 | 1 | 30 | 1 | OK |

`RESOURCE_LIMITS_EXCEEDED` arrives as **HTTP 200 with partial data plus a per-field `errors[]` array**,
not an HTTP failure — a client that only checks the status code will silently render holes. Adding
`mergeStateStatus` to the aliased query at `first:20` also produced `RESOURCE_LIMITS_EXCEEDED`
(first error path `["r0","pullRequests","nodes",0,"mergeStateStatus"]`).

**Practical ceiling: keep the aliased query at `first: 5–10` per repo when pulling reviews + check
rollup, and paginate rather than widen.**

### Benchmark: 10 repos, three ways

Repo set (public): `cli/cli denoland/deno oven-sh/bun vercel/next.js facebook/react microsoft/vscode
kubernetes/kubernetes nodejs/node golang/go rust-lang/rust`. Field set `$F` = the 18 fields in the table
above, `--limit 20`.

**Process floor** — `for i in $(seq 1 10); do /usr/bin/time -p gh --version; done`:

```
run1 0.18  run2..run10 0.02 each
n=10 total=0.360 mean=0.036 max=0.180
```

Warm `gh` startup is **0.02s**. `gh auth token` (hits the macOS keyring) mean **0.036s** over 5 runs.

**(a) Sequential** — `for r in $REPOS; do gh pr list -R $r --state open --limit 20 --json $F; done`:

```
cli/cli                8.47s  201,608 B
denoland/deno         11.20s        0 B   HTTP 504
oven-sh/bun            9.43s  567,352 B
vercel/next.js         8.62s  195,212 B
facebook/react         8.29s  312,674 B
microsoft/vscode       8.11s  222,575 B
kubernetes/kubernetes  6.84s   81,236 B
nodejs/node            6.32s  202,349 B
golang/go              6.29s   45,253 B
rust-lang/rust         7.75s  103,492 B
SEQ_TOTAL             82.06s
SEQ_TOTAL (repeat)    73.31s
```

**(b) Concurrent** — same 10, all backgrounded, `wait`:

```
PAR_TOTAL             11.35s   (denoland/deno still HTTP 504)
PAR4_TOTAL            21.88s   (xargs -P 4 pool)
PAR_LITE_TOTAL         7.25s   (all 10 OK; mergeable + mergeStateStatus dropped)
```

**(c) Single GraphQL query** — `gh api graphql -f query="$(cat q_both5.graphql)"`, 3 runs:

```
run1 8.94s cost=3 errs=0
run2 7.92s cost=3 errs=0
run3 8.08s cost=3 errs=0
```

Search variant, 3 runs: 9.09s / 7.00s / 7.42s, cost 3 each.

**Second repo set, 10 mid-size repos, `--limit 50`** (`charmbracelet/bubbletea junegunn/fzf
jesseduffield/lazygit sharkdp/bat BurntSushi/ripgrep sindresorhus/ky tmux/tmux astral-sh/uv cli/cli
golang/go`):

| Variant | Sequential | Concurrent | Failures |
|---|---|---|---|
| with `mergeStateStatus` | **88.70s** | 11.35s | 6/10 repos 502/504 |
| without `mergeStateStatus` | **62.84s** | **11.26s** | 1/10 (astral-sh/uv 504) |

Per-repo detail for the clean run (`--limit 50`, no `mergeStateStatus`): bubbletea 5.47s/50 PRs,
fzf 4.25s/50, lazygit 7.68s/50, bat 8.24s/50, ripgrep 10.18s/50, ky 0.65s/0, tmux 1.80s/17,
uv 11.30s/HTTP 504, cli/cli 8.58s/50, golang/go 4.14s/50.

**Interpretation.**

- Sequential shelling out is ~**7–8s per repo** — that is *server* latency, not process cost. The `gh`
  binary contributes **0.02s of the 7–8s (≈0.3%)**.
- Full concurrency collapses 82s → 11.35s, roughly the slowest single repo. A 4-way pool (21.88s) is
  measurably worse than unbounded-10, so **do not throttle at 4**.
- One GraphQL query at ~8s beats even full concurrency and returns fewer bytes, but only while the page
  size stays small.
- Note the floor: even a 0-open-PR repo costs 0.65–0.84s. Per-repo fan-out never gets cheaper than one
  round trip per repo.

### Rate-limit headroom

`gh api rate_limit` at session start:

```json
{"core":{"limit":5000,"used":0,"remaining":5000},
 "search":{"limit":30,"used":0,"remaining":30},
 "graphql":{"limit":5000,"used":6,"remaining":4994},
 "code_search":{"limit":10},"audit_log":{"limit":1750}}
```

**Measured per-call cost** (`graphql.used` sampled either side of the call):

- one `gh pr list --limit 20` with all 18 fields → **delta 1** (before 283, after 284).
- the 10-repo aliased GraphQL scan → **delta 3** (before 284, after 287).

After the entire benchmark session (~120 `gh pr list` calls + ~20 GraphQL scans):

```json
{"core":{"limit":5000,"remaining":4995,"used":5},
 "graphql":{"limit":5000,"remaining":4703,"used":297},
 "search":{"limit":30,"remaining":30,"used":0}}
```

So `gh pr list` is GraphQL under the hood and never touches the REST core bucket. A 50-repo per-repo
scan costs ~50 points; at 5000/hr that is **100 full scans per hour**, one scan every 36 seconds
indefinitely. **Rate limit is not the binding constraint — latency is.** The REST `search` bucket
(30/min) is only at risk if you use REST search; GraphQL `search` does not draw on it.

### Does `gh auth token` yield a usable token, and does bypassing `gh` save anything?

**Yes to the token, no to the saving.**

`gh auth token` returns a `gho_`-prefixed OAuth token (`gh auth token | cut -c1-4` → `gho_`). Control
experiment, identical GraphQL query, plain `curl`, no `gh` in the request path:

```sh
TOK=$(gh auth token)
curl -s -H "Authorization: bearer $TOK" -H "Content-Type: application/json" \
  --data "$(jq -n --arg q "$(cat q_both5.graphql)" '{query:$q}')" https://api.github.com/graphql
```
```
curl run1 8.56s cost=3 129,162 B
curl run2 9.24s cost=3 129,247 B
curl run3 8.03s cost=3 129,162 B
```

versus `gh api graphql` on the same query: 8.94s / 7.92s / 8.08s. **Indistinguishable.**

The real arguments for holding the token and speaking HTTP directly are therefore *not* speed:

1. **Control over the query** — `gh pr list`'s fragments are fixed. You cannot add `stack`, cannot drop
   `body` from `reviews` (which is most of the 567 KB from oven-sh/bun), cannot paginate `reviews`.
2. **Error visibility** — `gh` collapses partial GraphQL failures into a stderr string
   (`unexpected end of JSON input`, `stream error: stream ID 1; CANCEL`); direct HTTP hands you the
   structured `errors[]` with per-field paths, which is what degraded-state rendering needs.
3. **Rate-limit headers** — `x-ratelimit-remaining` comes back on every response for free rather than
   costing a separate `gh api rate_limit` call.

Cost of the direct route: you inherit token acquisition. Calling `gh auth token` once per launch
(0.036s, hits the keyring) is the pragmatic middle — use `gh` as the credential provider, not as the
transport. Fallback if `gh` is absent: `GH_TOKEN` / `GITHUB_TOKEN` env vars.

### Bonus: the one field `gh pr list --json` cannot supply

Stack membership is absent from the `--json` field list but selects cleanly in the same GraphQL round
trip already benchmarked:

```sh
gh api graphql -f query='query{rateLimit{cost remaining nodeCount}
  repository(owner:"cli",name:"cli"){pullRequests(states:OPEN,first:30,orderBy:{field:UPDATED_AT,direction:DESC}){
    nodes{number url stack{number size baseRefName} stackEntry{position}}}}}'
```
```json
{"rateLimit":{"cost":1,"remaining":4647,"nodeCount":30},"errs":0,
 "withStack":[{"n":14013,"stack":14025,"size":6,"base":"trunk","pos":5},
              {"n":14059,"stack":14025,"size":6,"base":"trunk","pos":6}]}
```

PRs not in a stack return `stack: null`. Cost 1 for 30 PRs. This independently corroborates the parent
session's observation and settles the architecture question: **the aliased GraphQL query is strictly
more capable than N `gh pr list` calls, at the same or better wall-clock, and it is the only route to
stack membership in one pass.** (Detailed stack semantics belong to ticket 0002.)

## Open gaps

- **Team review requests.** `reviewRequests` returned 78 nodes across 180 PRs, **all
  `__typename: "User"`**. `jq '[.[][].reviewRequests[]? | select(.__typename=="Team")]'` returned `[]`.
  The `Team` variant is in the schema and my query selected `... on Team { name }`, but I never saw one
  on the wire, so the team field name (`name` vs `slug`) and how `gh` flattens it into `--json` output
  is **unverified**. Would need a repo where a team is a requested reviewer.
- **>100 reviews on one PR.** `reviews(first: 100)` selects `pageInfo` but I could not find an open PR
  with >100 reviews in the sampled repos to confirm that `gh pr list` truncates rather than paginates.
  The source shows no pagination loop on the list path, so truncation is the strong reading — read from
  source, not observed.
- **Dismissed reviews.** `PullRequestReviewState` includes `DISMISSED`; the 61-PR review sample
  contained only `COMMENTED`, `CHANGES_REQUESTED` and `APPROVED`. How a dismissed review interacts with
  `latestReviews` and with `reviewDecision` is **untested**.
- **Private-repo timings.** All measurements are against public repos. Private repos under the `repo`
  scope may differ on latency (they should not on cost). Not measured — the ticket requires redaction
  and public repos were sufficient.
- **`mergeStateStatus` reliability threshold.** I proved it fails on busy repos and that dropping it
  fixes the scan. I did **not** establish a threshold (open-PR count, repo size) below which it is safe
  — only that `sindresorhus/ky` (0 open PRs, 0.84s) and `tmux/tmux` (17 open PRs, 2.56s) survived it.
- **Sustained-load rate-limit behaviour.** I measured cost per call and total consumption over one
  session (297 GraphQL points) but never approached the 5000/hr ceiling, so **secondary rate limits**
  (the undocumented concurrency/abuse limits that fire before the primary quota) were not exercised.
  Full fan-out at 50 repos might trip them; at 10 repos it did not.
- **Cold-start `gh` cost on a fresh shell.** The 0.18s first run is likely page-cache warming plus
  keyring init; measured once, not across reboots.
