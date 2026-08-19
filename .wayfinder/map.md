---
label: wayfinder:map
title: Build-ready spec for a read-only PR review TUI
---

# Build-ready spec for a read-only PR review TUI

## Destination

A `SPEC.md` complete enough to hand to an implementation agent with no open
questions: a terminal UI that scans an explicitly saved list of GitHub repos and
presents every open PR — grouped by relevance to me, showing review state, CI
status, mergeable state, draft, age, and stack membership — each with a link I
can open in the browser. GitHub-only in v1, behind a provider seam GitLab could
later implement.

**Widened 2026-08-07: the tool has memory.** It does not only answer "what is
true now" but "what changed since I last looked" — new review requests, PRs
pushed since I blocked them, silent retargets, PRs that have left the set. That
requires durable state across runs, which is why the store is SQLite rather than
the JSON cache it replaces: a pure cache would not justify a database, and at a
0.8s scan would barely justify existing. It also closes a gap the map already
documented as impossible — *The shape of the GitHub Pull Request Stacks API*
found that automatic retargeting is invisible to the API and can only be seen by
diffing against a prior scan.

**Widened 2026-08-19: GitLab is in scope.** The driver reversed the GitHub-only
call, so merge requests sit in the same list as pull requests, in the same
buckets, opened by the same keystroke. This is a scope reversal rather than an
addition, and the two providers do not map cleanly, so the provider seam must be
resolved before any GitLab code exists.

Measured before committing to it, and worth keeping in view: the driver has **8
open MRs on GitLab, all authored by them, 0 with review requested, 0 assigned**,
across two projects (`albanian-technology-distribution/kesh/kesh-back` and
`kesh-front`). GitLab therefore populates buckets 3, 4 and 5 — *Mine, …* — and
leaves the entire review side empty. That does not make it not worth doing; it
does mean the review-shaped parts of the taxonomy will go unexercised on GitLab
for now, and should not be over-designed on guesses.

## Notes

- **Domain**: developer tooling / terminal UI over the GitHub API via `gh`.
- **Planning-only was overridden on 2026-08-04.** The driver invoked `/implement`
  and a working tool now exists in `src/`, built on the decisions settled so far.
  Tickets 0004, 0006, 0009 were implemented from their *Direction from the
  driver* notes rather than from resolutions, and remain open — the code is one
  answer, not the decision. Tickets 0008 and 0011 are open too, so the stack
  treatment and the layout/keymap in `src/tui.ts` are explicitly prototype-grade
  and exist to be reacted to. Resolving any of these five should update the code
  as well as the ticket.
- **Skills every session should consult**: `/grilling` and `/domain-modeling` by
  default; `/research` for the research tickets; `/prototype` for the prototype
  tickets.
- **Environment facts already established** (do not re-litigate):
  - `gh` 2.96.0, authenticated as **ermand**; token scopes include `repo`,
    `read:org`.
  - `glab` 1.114.0, authenticated as **ermandduro** (user id 830730). GitLab is
    in scope as of 2026-08-19.
  - Available runtimes: Bun 1.3.14, Node 24.15.0, Go, Cargo 1.84.1, Python 3.14.6.
  - GitHub **Pull Request Stacks** entered public preview 2026-07-30 with REST
    endpoints for listing/getting stacks and a `stack` object on the PR resource;
    GraphQL exposes read-only stack fields. Exact shape is a research ticket.
- **Settled while charting**: read-only (no writes to GitHub); dashboard of all
  open PRs with relevance grouping as the default view; explicit saved repo list,
  no auto-discovery.
- **Settled while charting the state store (2026-08-07)**: `bun:sqlite` (built
  in, SQLite 3.51.0, `json1` available). **"Since I last looked" means since the
  last sync**, and **sync is an explicit on-demand act** — not a background poll
  and not an incidental side effect of opening the tool. The diff is therefore
  computed at sync time against the stored previous state and persisted, so it
  survives until the next sync. No per-PR read/unread state. This only holds
  because sync is deliberate: the driver owns the baseline, so a diff cannot be
  destroyed by a refresh they did not ask for.

## Decisions so far

<!-- one line per closed ticket: enough to judge relevance, then open the link -->

- [What PR data gh can return, and what a scan costs](./tickets/0001-gh-pr-data-and-scan-cost.md)
  — fetch via one hand-written aliased GraphQL query, not N `gh pr list`
  shell-outs (7.9–10.3s vs 82s sequential); `gh pr list --json` has 47 fields and
  no stack field; review state is derivable from a list query but stale reviews
  need `reviews[].commit.oid`; the real limit is a ~10s server-side execution
  budget that returns an HTML 502, not the rate limit.
- [The shape of the GitHub Pull Request Stacks API](./tickets/0002-stacks-api-shape.md)
  — stacks are readable now with no preview header or opt-in; membership rides on
  the PR list response as `stack { id, number, base, size, position }`, key
  omitted when absent; `stack`/`stackEntry` verified live inside a
  `pullRequests` connection; automatic retargeting is invisible to the API; only
  2 of 30 open `cli/cli` PRs were stacked, so the treatment must degrade to
  nothing.
- [Viable TUI stacks for a 2026 terminal app](./tickets/0003-tui-stack-landscape.md)
  — five candidates measured; Ratatui cannot emit OSC 8 hyperlinks and is close
  to disqualified; only Textual has first-class Tree/Collapsible; time to first
  frame spans 3.4ms (Ratatui) to 321ms (OpenTUI compiled), binaries 743KB to
  70MB; `gh-dash` is the existing analogue. No winner picked.
- [The PR review-state taxonomy](./tickets/0005-review-state-taxonomy.md)
  — four independent axes, not one status: **verdict** (`reviewDecision`, the
  badge), **standing** (viewer-relative), **readiness** (merge + checks) and
  **lifecycle** (draft). Standing turns out to be server-side via
  `viewerDidAuthor`/`viewerLatestReview`/`viewerLatestReviewRequest`, overturning
  0001; "someone reviewed" means `latestOpinionatedReviews`, which excludes bot
  comment-only reviews; `reviewDecision: null` is a real fourth verdict distinct
  from `REVIEW_REQUIRED`; identity comes from `viewer { login }`. Whole taxonomy
  is one query at cost 1. Vocabulary in [CONTEXT.md](../CONTEXT.md).
- [How many open PRs a scan actually fetches, and how it pages](./tickets/0013-scan-breadth-and-paging.md)
  — a scan is **two `search` queries**, not a walk over the repo list: the saved
  repos become `repo:` scope qualifiers. `review-requested:@me` and
  `involves:@me`, unioned. Two are required because `involves:` excludes review
  requests — measured, it missed 27 of 32. Cost 1 each, 0.5–0.8s, parallel,
  versus 323s and cost 119 for full per-repo pagination. Truncation becomes moot:
  the filters define the set rather than clipping it.
- [Relevance buckets and sort order](./tickets/0007-relevance-buckets-and-sort.md)
  — **seven buckets, first match wins**: Awaiting me → I blocked it and it moved →
  Mine ready to land → Mine needs work → Mine waiting → I blocked it unchanged →
  Ambient. Per-bucket sort keys with a deterministic repo+number tiebreak; empty
  buckets render nothing; one view plus a grouping toggle and filter line; nothing
  hidden by default. Bucket 2 earns its place — 32 of 40 sampled changes-requested
  PRs carried a stale block. **Amends 0005**: my blocking review must be read from
  `latestOpinionatedReviews` filtered to the viewer, not `viewerLatestReview`,
  since a later comment masks a standing block. Also: `ReviewRequest` has no
  timestamp, and drafts can carry review requests.

**The state store was built on 2026-08-07** while tickets 0014–0018 were still
open, so each of them now carries an *Implemented as a prototype* section
describing the position taken. Two spec-level facts came out of running it, and
both belong here rather than in a ticket:

- **Learning a previously unknown value is not a change, but the guard must be
  directional.** `mergeable` resolves lazily, so a first sync of 29 real PRs
  returned `UNKNOWN` for 19 and a second sync seconds later reported 19 spurious
  transitions. Suppressing symmetrically then hid a genuine
  `unknown → conflicted`, which is the ordinary shape of a real conflict because
  `mergeable` returns to `UNKNOWN` whenever the base moves. The same applies to
  `statusCheckRollup`, which is null until the first check run exists on the head
  commit — so `checks: none` also means "pushed seconds ago", not only "no CI".
- **28 of the driver's 29 PRs have no CI at all** (`checks: none`). That measured
  distribution retroactively justifies the amendment to 0007 admitting `none`
  into *Mine, ready to land*: without it, essentially every PR of the driver's
  would be unable to reach that bucket.
- [How GitLab is queried for the merge requests that concern me](./tickets/0019-gitlab-mr-api.md)
  — one GraphQL query, `projects(fullPaths: [...]) { mergeRequests }`, complexity
  independent of project count: 1 request and 0.82–0.96s against 18 requests and
  11.63s for REST at equal fidelity. **`involves:@me` has no GitLab equivalent and
  cannot have one** — mentions and commenter are unfilterable in both APIs, proven
  by exhaustion, so the GitLab scan inverts GitHub's into fetch-then-filter on
  `commenters`/`participants`. Three silent traps recorded, including REST
  ignoring unknown filters with a 200.
- [What GitLab can say about a merge request's state](./tickets/0020-gitlab-review-model.md)
  — every axis is supported or derivable except `i-commented`, which is impossible
  at scan cost. **`REQUESTED_CHANGES` exists but is tier-gated**, and the driver's
  own projects are Free, so bucket 2 is structurally unreachable there.
  **`staleBlock` degrades from exact to approximate**: GitLab attaches no commit to
  a review state, so it becomes timestamp-based and 20% undecidable. Five lazily
  computed fields named. `MergeRequest.stack` exists but is a **path, not a
  partition** — one MR can sit in several stacks, counts only open layers, and has
  no identity, which falsified `CONTEXT.md` and is now corrected there.
- **A latent bug in shipped GitHub code, found by porting.** Every sort compared
  timestamps as raw strings, which is only chronological while every value ends in
  `Z`. GitLab's `committedDate` carries offsets: `2026-04-16T17:54:22+02:00` is
  15:54Z and so precedes `16:23:37Z` while sorting after it. Timestamps are now
  canonicalised to UTC in `normalize`.
- [The provider seam GitLab would implement](./tickets/0010-provider-seam.md)
  — one operation, `scanProvider(projects) -> { rows, failed }`, with each provider
  owning its own query shape rather than a shared query language. **A baseline per
  provider**: GitLab failing never freezes GitHub's diff, which matters because the
  driver's GitLab token already expired once and all-or-nothing would have frozen
  29 PRs over 8 MRs. **The union model with per-row precision**, not the
  intersection — reducing to what both can express would degrade the GitHub board
  and specifically weaken bucket 2. Precision rides on the **row**, because
  capability is per-*project*: a blocking review is reportable on a paid GitLab
  project and invisible on a free one within one scan. `staleBlock` becomes
  `{value, precision} | null`; `stack` becomes plural `stacks`, since GitLab
  membership is a path rather than a partition. Viewer and credential are
  per-provider. Amends 0014, 0016 and 0004.
- [How a saved entry declares which provider it belongs to](./tickets/0022-declaring-a-provider.md)
  — **two lists**, `github:` and `gitlab:`, so provider is structural rather than
  parsed. Depth inference was ruled out by evidence: `gitlab-org/gitlab` is depth 2,
  identical in shape to a GitHub `owner/repo`. **Validation is per-provider because
  the risk is** — GitHub's path is interpolated into a `repo:` qualifier and stays
  strictly `owner/name`, GitLab's is a bound GraphQL variable and only needs typo
  checks. Config keyed by path, store still keyed by node id, so a renamed project
  loses its entry but keeps its history. **`projects(fullPaths:)` silently omits a
  path it cannot see** — HTTP 200, no error — so the scan must diff requested
  against returned paths and treat a missing one as a provider failure, or a typo
  reads as "no open MRs". `repos:` is retired loudly, not aliased.

## Not yet specified

- **Storing review activity as a work history.** Beyond this tool — a durable,
  queryable record of review activity over time, feeding things that are not this
  dashboard. Raised while widening the destination and deliberately left here: it
  stops being a PR dashboard, so if it is wanted it is a fresh map, not a
  continuation of this one.
- **Degraded and error states.** The failure surface shrank with the scan design —
  two cheap queries, either of which can return an HTML 502 that will not parse as
  JSON, or an HTTP 200 carrying partial `data` plus a per-field `errors[]` array.
  A partial union must read as incomplete rather than as whole. How the *TUI* says
  so still hangs on the layout existing to place it in.
- **First-run and empty states.** No repos saved yet, and a saved repo with zero
  open PRs. Hangs on how the repo list is managed. Note the empty-*store* first
  run has graduated into *What sync is, and what the first one does*.
- **Distribution and install.** Homebrew, `go install`, npm, a single binary.
  Hangs on the tech stack choice. Measured binary sizes now span 743KB (Rust) to
  70MB (OpenTUI), so this is a real axis rather than a footnote.
- **Colour, theming, and terminal capability fallbacks.** Hangs on the layout.
- **Team-routed review requests.** `team-review-requested:<org>/<team>` is a valid
  qualifier but needs team slugs, which the repo list does not carry. Surfaced by
  the scan-strategy work; too coarse to ticket until it is known whether any of
  the driver's review requests actually arrive via a team.
- **Whether `gh-dash` already does this job.** A PR dashboard on Bubble Tea v2
  turned up during the TUI survey. Worth an honest look before specifying a
  competitor to it; too coarse to ticket until someone has actually run it.

## Out of scope

<!-- ruled beyond the destination; closed, never graduates -->

- ~~**GitLab stack inference**~~ — **retracted 2026-08-19, the premise was false.**
  This was ruled out on the grounds that GitLab has no equivalent of GitHub's
  stacks and one would have to be inferred from branch chains. Introspection of
  the live schema disproves it: `MergeRequest.stack: [MergeRequest!]` exists on a
  129-field type, alongside `approvalState`, `conflicts`, `detailedMergeStatus`,
  `diffHeadSha`, `headPipeline`, `reviewers`, `commenters` and `participants`.
  Nothing needs inferring. Whether GitLab stacks are *rendered* is a live question
  for [How a stack renders in a flat PR list](./tickets/0008-stack-rendering.md)
  and the provider seam, not a scope boundary.
- **Any write to GitHub** — approve, comment, merge, re-request review. The TUI
  shows state; the browser link is the action.
- **Background daemon and desktop notifications** — v1 is a TUI you open.
- **GitHub Enterprise Server hosts and multiple accounts** — one authenticated
  `gh` account against github.com.
- **Review comment bodies** — review *state* is in; reading the discussion is the
  browser's job.
- **Repo auto-discovery** — from an org or from a local directory tree. The list
  is explicit and saved.
