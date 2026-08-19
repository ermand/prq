---
id: 0020
title: What GitLab can say about a merge request's state
parent: map
type: research
status: closed
assignee: Main
blocked_by: []
---

## Question

The four state axes are settled for GitHub in
[0005](./0005-review-state-taxonomy.md). What can GitLab report for each, and
what can it not report at all?

GitHub gives a review decision, per-reviewer review states with the commit each
was made against, and viewer-relative fields (`viewerDidAuthor`,
`viewerLatestReview`, `viewerLatestReviewRequest`). GitLab uses **approvals**,
which is a different model, and the mismatch decides how much of the bucket
structure survives a second provider.

To establish, axis by axis:

- **Verdict.** What GitLab reports for approval state, and whether anything
  corresponds to `CHANGES_REQUESTED`. If a reviewer cannot record "changes
  requested" in a form the API exposes, say so plainly: buckets 2 and 6 rest
  entirely on it.
- **Standing.** Whether each of `mine`, `awaiting-me`, `i-requested-changes`,
  `i-approved`, `i-commented`, `not-involved` is reportable, derivable
  client-side, or impossible.
- **Stale block.** Bucket 2 is the most actionable state in the tool and needs a
  blocking opinion of mine plus the commit it was made against, compared to the
  current head. Whether GitLab exposes enough to reconstruct that — via
  approval-reset-on-push, unresolved threads carrying a sha, or anything else.
  The sharpest question here.
- **Readiness.** `merge_status` / `detailed_merge_status`, conflicts, and pipeline
  status, with their real enum values mapped onto `clean|conflicted|unknown` and
  `success|failing|pending|none`.
- **Lifecycle.** Draft detection, and whether the WIP title prefix still matters.
- **Lazily computed fields.** Which GitLab fields resolve asynchronously. The
  GitHub port was bitten twice by exactly this — `mergeable` and
  `statusCheckRollup` both resolve late and produced spurious change reports on
  the second sync. Any GitLab field with the same behaviour must be named now.

Note the driver's own account cannot exercise the viewer-relative axes: 0 review
requests, 0 assignments. Observations for those must come from a project with
visible reviewer activity, and must say which account they came from.

Findings: [0020-gitlab-review-model.md](../research/0020-gitlab-review-model.md)

## Resolution

Findings: [0020-gitlab-review-model.md](../research/0020-gitlab-review-model.md) —
762 lines, 73 live claims, a field-by-field mapping marking every axis
supported / derivable / impossible.

**Verdict has no single field**, but composes from `approvedBy` +
`changeRequesters` + `approvalsRequired`. **`CHANGES_REQUESTED` does exist**:
`MergeRequestReviewState` enumerates `REQUESTED_CHANGES`, and
`MergeRequest.changeRequesters` agreed exactly with that reviewer set on every MR
sampled. 58 open `gitlab-org/gitlab` MRs carry a blocking reviewer, so bucket 2 is
well populated *there*.

**But it is tier-gated, and the driver is on the wrong side of the gate.**
`changeRequesters` returned `null` on all 8 Free-tier kesh MRs, versus `{"nodes":[]}`
on Ultimate MRs that merely have none. **Bucket 2 is structurally unreachable on
the driver's own projects.** The null doubles as a free per-project capability
probe, avoiding the 403-guarded settings endpoint.

**`approved` is a trap.** It means "satisfies the required count", not "someone
approved" — and REST `/approvals` returned `approved: true` while GraphQL returned
`false` on the same 4 MRs in the same minute. The verdict mapping must pick one
source deliberately.

**Standing is fully derivable**, with no `viewer*` fields: read
`reviewers[].mergeRequestInteraction` (`reviewState`, `approved`, `reviewed`,
`updatedAt`) and filter client-side on `currentUser.username`. Only
`i-commented` is **impossible at scan cost**, for the reason
[0019](./0019-gitlab-mr-api.md) established. GitLab beats GitHub on one point:
`mergeRequestInteraction.updatedAt` gives a review request a real timestamp, which
0005 established GitHub lacks entirely.

**Stale block degrades from exact to approximate — the sharpest finding.** GitLab
records **no commit against a review state**, so the sha-equality test in
`isStaleBlock` cannot be ported. The only workable primitive is a timestamp
comparison: `mergeRequestInteraction.updatedAt` against the newest
`mergeRequestDiffs` entry. Measured across all 58 blocking MRs: **16 stale, 32
fresh, 12 undecidable** because `updatedAt` was null — 20% of the blocking cohort.
A sha-exact escalation exists via `Note.position.diffRefs.headSha` but costs one
request per MR and only works when the blocker left a diff note.

And an asymmetry that inverts GitHub's assumptions: on GitLab a
`REQUESTED_CHANGES` **survives a push** while approvals are **deleted** on push by
default. GitLab has essentially no stale *approval*, only stale *blocks*.

**Five lazily computed fields**, the trap that bit the GitHub port twice:
`merge_status`/`detailed_merge_status` (`UNCHECKED` on 3 of the driver's 8 MRs —
38%, so not first-sight-only), `has_conflicts` (documented as derived from
merge_status; caught live reporting `false` while `detailed_merge_status` was
`CONFLICT`), `head_pipeline` (observed null while a pipeline existed; also
permission-gated), `diff_refs` and `changes_count`. `prepared_at` is the honest
settled-once gate. Also: **`headPipeline.sha != diffHeadSha`** under merged-results
pipelines (0/4 on gitlab-org, 8/8 on kesh), so the obvious stale-pipeline check is
wrong.

**Lifecycle**: `draft === work_in_progress` on all 8 MRs, and the `WIP:` prefix no
longer marks a draft — two of the driver's MRs titled `WIP:` report
`draft: false`, so title parsing would misclassify 25% of their board.

**Stacks exist and are the wrong shape**, which is worse for the seam than absence.
`MergeRequest.stack` is Free-tier and populated on 24/100 `gitlab-org/gitlab`,
24/56 `gitlab-org/cli`, 12/64 `gitlab-org/gitaly` open MRs. Four corrections to
GitLab's own docs, all measured: it **includes self** despite saying "Other" (24/24),
which is what makes position derivable; it returns `[]` not `null` when unstacked
(0 nulls in 246 MRs); it is **open-only**, so a partly-landed stack cannot report
`5/6`; and it is a **path, not a partition** — `gitaly!8812` appears in three
stacks simultaneously, falsifying `CONTEXT.md`'s "exactly one stack or none", now
corrected there. There is no stack identity or number.

**Two porting traps that would fail silently**, both confirmed independently:
GitLab's `commits(last: 1)` returns the **oldest** commit, the opposite of GitHub —
and `src/query.ts` uses exactly that idiom. And `committedDate` carries timezone
offsets, which breaks the lexicographic date comparisons in `src/domain.ts`.
Verified live: `2026-04-16T17:54:22+02:00` is 15:54Z, so it precedes a sibling
`16:23:37Z` while sorting after it. **Fixed immediately** — timestamps are now
canonicalised to UTC in `normalize`, with a regression test, since the latent bug
was in shipped GitHub code.
