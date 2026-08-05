---
id: 0005
title: The PR review-state taxonomy
parent: map
type: grilling
status: closed
assignee: Main
blocked_by: [0001]
---

## Question

What is the vocabulary of PR states this tool displays, and what is the rule that
assigns exactly one of them to a PR?

This is the domain model. "Status" in the original ask was doing several jobs at
once — review decision, my personal relationship to the PR, CI health,
mergeability — and they are different axes. Resolve:

- Which axes exist and stay separate. A candidate split: *review decision*
  (approved / changes requested / review required), *my standing* (awaiting my
  review / I approved / I requested changes / not involved / I authored),
  *readiness* (checks green / red / pending, mergeable / conflicted), *lifecycle*
  (draft / ready).
- The canonical name for each value. These names surface in the UI and in the
  code, so settle them here rather than letting the implementation invent them.
- Precedence when several apply. A PR I authored, with changes requested by
  someone else, failing CI — what does its row say first?
- What "someone else has already reviewed" means precisely: any review event,
  the latest review per reviewer, or an approval specifically. Whether a stale
  review — one superseded by a later push — still counts as reviewed.
- How "me" is identified. The `gh` authenticated login, or a configured
  identity, and what happens across accounts.
- Whether a state can be unknown, and what makes it unknown.

Constrain every proposed state to something *What PR data gh can return, and
what a scan costs* proved observable. Do not invent states the API cannot
support.

Record the resulting vocabulary in `CONTEXT.md`.

## Resolution

Vocabulary recorded in [CONTEXT.md](../../CONTEXT.md). Every field below was
verified live on 2026-08-04 in a single `gh api graphql` query against `cli/cli`
at **cost 1** with zero errors — the whole taxonomy is one round trip.

### Four axes, kept separate

The driver's "Approved / Requested Changes / just plain new" is the **badge**,
not the model — option (a). It is GitHub's repo-wide `reviewDecision` and says
nothing about the viewer, so it cannot drive relevance grouping on its own.
The other three axes survive alongside it.

| Axis | Source field | Values |
| --- | --- | --- |
| **Verdict** | `reviewDecision` | `approved`, `changes-requested`, `awaiting-review`, `review-optional` |
| **Standing** | `viewerDidAuthor`, `viewerLatestReview`, `viewerLatestReviewRequest` | `mine`, `awaiting-me`, `i-requested-changes`, `i-approved`, `i-commented`, `not-involved` |
| **Readiness** | `mergeable`, `commits(last:1).nodes[0].commit.statusCheckRollup.state` | merge: `clean`/`conflicted`/`unknown`; checks: `success`/`failing`/`pending`/`none` |
| **Lifecycle** | `isDraft` | `draft`, `ready` |

Plus age from `createdAt`/`updatedAt`, and stack membership from
`stack`/`stackEntry`.

### The `null` verdict is a real fourth case

`PullRequestReviewDecision` enumerates only `APPROVED`, `CHANGES_REQUESTED`,
`REVIEW_REQUIRED` — but the field is nullable and `null` was observed live
(`cli/cli` #14062, with one review request outstanding). `null` means the
repository does not *require* review; `REVIEW_REQUIRED` means it does and none has
landed. "Just plain new" is those two different things, so they get two names:
`review-optional` and `awaiting-review`.

### Standing is server-side, not derived

This overturns 0001's conclusion that latest-per-reviewer must be reconstructed
client-side. `PullRequest` exposes `viewerDidAuthor`, `viewerLatestReview` and
`viewerLatestReviewRequest` directly — confirmed by schema introspection and
returned live alongside `viewer { login }`, which also settles identity.

Precedence, first match wins: `mine` → `awaiting-me` → `i-requested-changes` →
`i-approved` → `i-commented` → `not-involved`. `mine` leads because you cannot
review your own PR. `awaiting-me` absorbs the re-request case — you reviewed, the
author pushed and asked again, so a live request outranks your stale opinion.

### "Someone else has already reviewed" means an opinionated review

Use `latestOpinionatedReviews`, not `latestReviews`. It admits only `APPROVED`
and `CHANGES_REQUESTED`, excluding comment-only and pending reviews. This matters
in practice: the live sample's only `latestReviews` entries included
`copilot-pull-request-reviewer` with state `COMMENTED`, which would otherwise
register as "someone reviewed this".

### Staleness

A review is stale when its `commit.oid` differs from the PR's `headRefOid`. Both
`viewerLatestReview { commit { oid } }` and
`latestOpinionatedReviews { nodes { commit { oid } } }` carry it, so staleness is
available for your review and everyone else's. It is a flag on a review, not a
verdict value — a stale approval is still an approval on the record.

### Identity

`viewer { login }` in the same query — returned `ermand`. Never configured, so it
cannot drift from the token in use. If the token changes, "me" changes with it,
which is the correct behaviour.

### Unknown is legitimate

`MergeableState` includes `UNKNOWN`: GitHub computes mergeability lazily, so a
first sight of a PR can legitimately return it. The check rollup is `null` when a
repo has no CI. Both render as unknown rather than as failure. A repo whose fetch
failed leaves all of its PRs unknown.

### Enums, introspected verbatim

- `MergeableState`: `MERGEABLE CONFLICTING UNKNOWN`
- `StatusState`: `EXPECTED ERROR FAILURE PENDING SUCCESS`
- `PullRequestReviewDecision`: `CHANGES_REQUESTED APPROVED REVIEW_REQUIRED` (nullable)
- `PullRequestReviewState`: `PENDING COMMENTED APPROVED CHANGES_REQUESTED DISMISSED`

### Excluded

`mergeStateStatus` is not used. It measurably doubles single-repo query latency
(3.48s → 5.42s, reproducible) and buys nothing `mergeable` plus the check rollup
does not already give.

## Amendment — 2026-08-04, from *Relevance buckets and sort order*

**`i-requested-changes` and `i-approved` must be derived from
`latestOpinionatedReviews` filtered to `viewer.login`, not from
`viewerLatestReview`.**

A comment-only review does not dismiss a standing changes-request, but it *does*
become `viewerLatestReview.state`. Reading standing from that field silently
downgrades a live block to `i-commented`. Confirmed live: `oven-sh/bun#36831` has
`Jarred-Sumner` at `latestReviews → COMMENTED` while
`latestOpinionatedReviews → CHANGES_REQUESTED`.

There is no `viewerLatestOpinionatedReview` field, so the filter is client-side
over data already selected — no extra cost. `viewerLatestReview` stays correct for
`i-commented`: a review by me with no opinionated counterpart.

Also established there: `ReviewRequest` carries **no timestamp** (fields are
`asCodeOwner`, `databaseId`, `id`, `pullRequest`, `requestedReviewer`), so "how
long has this been waiting on me" has no exact answer; and a **draft PR can carry
a review request**, so `awaiting-me` and `draft` co-occur.
