---
id: 0007
title: Relevance buckets and sort order
parent: map
type: grilling
status: closed
assignee: Main
blocked_by: [0005, 0013]
---

## Question

What are the relevance groups, in what order do they appear, and how is each one
sorted inside itself?

The default view is every open PR in the tracked repos, grouped by relevance to
me, with the grouping droppable. Turn that into something implementable:

- The exact list of buckets and their order. A starting candidate: needs my
  review → I requested changes and it has been updated since → mine and blocked
  on someone → mine and ready to merge → mine and waiting → everything else.
- Which bucket a PR lands in when it qualifies for two, using the precedence
  settled in *The PR review-state taxonomy*.
- The sort inside a bucket, and the tiebreak. Age, last activity, repo, or CI
  state.
- Whether buckets can be empty and still render as headers, and whether they
  collapse.
- What "drop the grouping" produces — a flat list sorted by what?
- Whether other views exist at all in v1 (by repo, by author, only mine), or
  whether that is one view with a sort toggle.
- Whether any PR is hidden by default rather than merely sorted last — bots,
  Dependabot, drafts by others.

## Resolution

**Seven buckets, first match wins.** Option (b). The scan design reshaped this
ticket before it was worked: with `review-requested:@me` ∪ `involves:@me`, every
PR in the set already concerns the viewer, so the "everything else" remainder
sketched at charting does not exist. The buckets are the **standing** axis
refined by **readiness**.

| # | Bucket | Membership | Sort within |
| --- | --- | --- | --- |
| 1 | **Awaiting me** | standing `awaiting-me` — a live request of me, unanswered, including a re-request after I already reviewed | `createdAt` **asc** — oldest ask first; personal requests before CODEOWNERS ones |
| 2 | **I blocked it, and it moved** | my opinionated review is `CHANGES_REQUESTED` **and** its `commit.oid` ≠ `headRefOid` | `updatedAt` **desc** — newest push is newest information |
| 3 | **Mine, ready to land** | `viewerDidAuthor`, verdict `approved`, checks `success`, merge `clean` | `updatedAt` **asc** — ready longest |
| 4 | **Mine, needs work** | `viewerDidAuthor` and (verdict `changes-requested` or checks `failing` or merge `conflicted`) | `updatedAt` **desc** |
| 5 | **Mine, waiting** | `viewerDidAuthor`, anything else — awaiting review, checks pending, draft | `createdAt` **asc** — longest neglected |
| 6 | **I blocked it, unchanged** | my opinionated review is `CHANGES_REQUESTED`, `commit.oid` = `headRefOid` | `updatedAt` **desc** |
| 7 | **Ambient** | everything left — I approved, I commented, or I was only mentioned or assigned | `updatedAt` **desc** |

Tiebreak everywhere: repository `nameWithOwner`, then PR number ascending.
Deterministic, so the list does not shuffle between scans.

Buckets 1, 2, 6 and 3, 4, 5 are disjoint by construction — you cannot review your
own PR — so the only precedence that does real work is 1 over 2 and 6, which 0005
already settled: a live request outranks a stale opinion of yours.

**Why bucket 2 earns its row.** A PR you blocked that has since been pushed to is
invisible in a five-bucket scheme, and it is the most actionable state on the
board: someone is waiting on you and does not know it. Measured on 40 sampled
open `changes-requested` PRs, **32 carried a stale blocking review** — this
bucket is well populated, not a corner case.

### Correction to the standing derivation in 0005

Bucket 2 and bucket 6 must read my blocking review from
`latestOpinionatedReviews` filtered to `viewer.login`, **not** from
`viewerLatestReview`. A later comment-only review does not dismiss a standing
changes-request, but it *does* become `viewerLatestReview.state`, which would
silently move the PR out of bucket 2 and into *Ambient*.

Confirmed live: `oven-sh/bun#36831` has `Jarred-Sumner` at
`latestReviews → COMMENTED` while `latestOpinionatedReviews → CHANGES_REQUESTED`.
One case in 40 — rare, and the failure is exactly the bucket vanishing.

There is no `viewerLatestOpinionatedReview` field, so the filter is client-side
over data already selected. `viewerLatestReview` remains the right source for
`i-commented` — a review by me with no opinionated counterpart.

### Review requests carry no timestamp

`ReviewRequest` exposes only `asCodeOwner`, `databaseId`, `id`, `pullRequest`,
`requestedReviewer` — introspected. "Oldest review request first" is therefore not
directly available; bucket 1 sorts on PR `createdAt` ascending as the proxy. It is
wrong whenever a reviewer was added long after a PR opened; accepted, because the
alternative is a per-PR timeline query.

`asCodeOwner` is a genuine signal and is used: a request addressed to you
personally sorts above one you received because you are on the owners list.

### Drafts are not excluded

A draft **can** carry a review request — 3 of 50 sampled open drafts did, with
`reviewDecision: REVIEW_REQUIRED`. So a draft can legitimately reach bucket 1.
Drafts stay in whatever bucket they qualify for, sort last within it, and render
de-emphasised.

### Settled defaults

- **Empty buckets render nothing** — no header, no scaffolding.
- **Drop-grouping toggle** gives a flat list, `updatedAt` descending.
- **One view in v1** — the grouping toggle plus a filter line. No by-repo or
  by-author modes.
- **Nothing is hidden by default.** Bot PRs only enter the set if you are a
  requested reviewer or have commented, so the scan already excludes the noise;
  filtering again would be hiding the same thing twice.
