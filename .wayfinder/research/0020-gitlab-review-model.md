# GitLab's review model against the four state axes

Research for [ticket 0010 — the provider seam](../tickets/0010-provider-seam.md).
Answers "what does GitLab report for each axis in [CONTEXT.md](../../CONTEXT.md)"
so the seam can be specified against two real providers rather than one.

Companion: [0019 — GitLab MR API fetch semantics](0019-gitlab-mr-api.md) covers
endpoints, scoping and paging. This file covers only the state model.

All `[LIVE]` observations were made 2026-08-19 with `glab 1.110.0` authenticated as
**ermandduro** (user id 830730) unless a different account is named. The driver's own
projects — `albanian-technology-distribution/kesh/kesh-back` (id 32073208, 6 open MRs)
and `kesh-front` (id 32344706, 2 open MRs) — are **GitLab Free** with no approval rules
and zero reviewers, so every viewer-relative and approval-relative observation comes
from `gitlab-org/gitlab`, `gitlab-org/cli` and `gitlab-org/gitaly` (Ultimate), read from
the same ermandduro account. GraphQL reads are POST by protocol but query-only; no
mutation was issued.

## Summary

- **Verdict has no single field.** GitHub's `reviewDecision` collapses to one enum;
  GitLab splits it across `approved`/`approvalsRequired`/`approvalsLeft` (the approval
  half) and `changeRequesters` / `reviewers[].mergeRequestInteraction.reviewState` (the
  opinion half). `detailedMergeStatus` is the closest single field and is the wrong
  shape — it reports the *first blocking reason*, not a review decision.
- **`CHANGES_REQUESTED` exists, and there is a dedicated field for it.**
  `MergeRequest.changeRequesters` — "Users that have requested changes to the merge
  request" — agreed exactly with the `REQUESTED_CHANGES` reviewer set on every MR
  sampled. `gitlab-org/gitlab` had **58 open MRs** with a blocking reviewer, so bucket 2
  is as well-populated on GitLab as on GitHub. Unresolved threads are a *separate*,
  weaker signal — not the substitute.
- **But it is tier-gated, and the driver's projects cannot produce it.**
  `changeRequesters` returned **`null` on all 8** of the driver's Free-tier MRs and `[]`
  or a populated connection on every Ultimate MR — including Ultimate MRs with no change
  requesters at all. Bucket 2 is structurally empty on `kesh-back`/`kesh-front`.
- **`approved` is a trap, and the two APIs disagree.** It means "satisfies the required
  approval count", not "somebody approved". REST `/approvals` returned `approved: true`
  on 4/4 of the driver's MRs that have **zero** approvals, while GraphQL returned
  `approved: false` for the same 4 MRs in the same minute. Never map either onto
  `verdict === "approved"`; use `approvedBy` membership.
- **Standing is fully derivable, and cheaper than GitHub's.** There is no `viewer*`
  field, but `reviewers[].mergeRequestInteraction` gives per-user `reviewState`,
  `approved`, `reviewed` and `updatedAt` in the same selection, filtered client-side by
  `currentUser.username` — the same client-side filter 0005's amendment already forced
  for GitHub. Only `i-commented` is not derivable from a list query.
- **Stale block is reconstructable only by timestamp, never by sha.** GitLab records no
  commit against a review state. The honest primitive is
  `mergeRequestInteraction.updatedAt < mergeRequestDiffs(first:1).nodes[0].createdAt`.
  Measured across all 58 blocking MRs: **16 stale, 32 fresh, 12 undecidable** because
  `updatedAt` was `null`. A 20% unknown rate in the tool's most actionable bucket is the
  single biggest honesty cost of the port.
- **A blocking review survives a push; an approval does not.** Live: five MRs pushed
  after a `REQUESTED_CHANGES` still report it. Approvals, by contrast, are *removed* on
  push by default (Premium+, `git patch-id`-aware), so GitLab has almost no "stale
  approval" concept — the asymmetry is exactly backwards from what a GitHub port expects.
- **Five fields are computed lazily or asynchronously.** `merge_status` /
  `detailed_merge_status` (`UNCHECKED` observed on 3 of the driver's 8 MRs),
  `has_conflicts` (documented as *derived* from `merge_status`; observed `false` on an MR
  whose `detailed_merge_status` was `conflict`), `head_pipeline` (observed `null` while a
  pipeline existed), `diff_refs` and `changes_count` (documented empty on create). The
  GitHub port was bitten twice by exactly this; GitLab has more of it.
- **Stacks exist — ticket 0010's premise is wrong.** `MergeRequest.stack` is a live
  field, populated on **24/100** open `gitlab-org/gitlab` MRs, **24/56** on
  `gitlab-org/cli`, **12/64** on `gitlab-org/gitaly`, and available on Free tier. But it
  is a *path through a tree, not a partition*: `gitaly!8812` appears in three different
  reported stacks simultaneously, so CONTEXT.md's "a PR is in exactly one stack or none"
  is false here. **Position survives the port; Size does not.** Asking nine MRs of one
  `gitlab-org/cli` family returns arrays of length 3, 5 and 6 depending on the querier,
  because the API picks one branch arbitrarily wherever the tree forks above you — and
  separately, merged layers are excluded. CONTEXT.md's `5/6` has no GitLab denominator.
- **Two porting traps in the GraphQL shape.** `commits(last: 1)` is the **oldest** commit
  on GitLab (matched `diffHeadSha` 14/40) — the opposite of GitHub; use
  `commits(first: 1)` (40/40) or just `diffHeadSha`. And `Commit.committedDate` returns
  offset-bearing ISO strings (`2026-08-19T12:06:29+02:00`), so the lexicographic date
  compares used throughout `src/domain.ts` would silently misorder them.

## Findings

### 1. Verdict — what GitLab reports for an MR's collective decision

There is no `reviewDecision`. Three separate mechanisms carry pieces of it.

**Approvals.** `GET /projects/:id/merge_requests/:iid/approvals` returns the whole MR
representation plus these approval keys, verbatim `[LIVE]`
(`glab api "projects/gitlab-org%2Fgitlab/merge_requests/250822/approvals"`):

```
approved, approvals_required, approvals_left, approved_by, approvers,
approver_groups, suggested_approvers, approval_rules_left,
has_approval_rules, invalid_approvers_rules, merge_request_approvers_available,
multiple_approval_rules_available, require_password_to_approve,
user_can_approve, user_has_approved
```

GraphQL exposes the same on `MergeRequest` directly: `approved`, `approvalsRequired`,
`approvalsLeft`, `approvedBy { nodes { username } }`, `approvalState { rules { … } }`
`[LIVE]`.

**`approved` does not mean what the name says.** Documented as "Indicates if the merge
request has all the required approvals" `[DOCS]` (GraphQL schema description,
introspected `[LIVE]`). Across 60 open `gitlab-org/gitlab` MRs, `approved` correlated
with `approvalsLeft === 0` in 60/60 cases, and **9 of 60 reported `approved: true` with
an empty `approvedBy`** `[LIVE]`. On a project with `approvalsRequired: 0` — which is
every Free-tier project, including both of the driver's — `approved` degenerates.

Worse, **REST and GraphQL disagree on the same MR** `[LIVE]`:

| MR | REST `/approvals` | GraphQL `MergeRequest` |
| --- | --- | --- |
| kesh-back!326 | `approved=True required=0 left=0` | `approved=False required=0 left=0` |
| kesh-back!322 | `approved=True required=0 left=0` | `approved=False required=0 left=0` |
| kesh-back!287 | `approved=True required=0 left=0` | `approved=False required=0 left=0` |
| kesh-back!285 | `approved=True required=0 left=0` | `approved=False required=0 left=0` |

Commands, run back to back:
`glab api "projects/albanian-technology-distribution%2Fkesh%2Fkesh-back/merge_requests/<iid>/approvals"`
versus
`glab api graphql -f query='query { project(fullPath:"albanian-technology-distribution/kesh/kesh-back"){ mergeRequest(iid:"<iid>"){ approved approvalsRequired approvalsLeft } } }'`.
4/4 divergent — independently reproduced by GitLabApiScout in 0019. REST reads "0
required" as vacuously approved; GraphQL as "nobody approved". **Neither field is usable
for verdict.** `approvedBy.nodes.length > 0` is the only honest "somebody approved"
signal, and it makes the REST/GraphQL choice moot rather than load-bearing.

**Requested changes is first-class, with a dedicated field.** Introspected `[LIVE]`:

```
MergeRequestReviewState: UNREVIEWED REVIEWED REQUESTED_CHANGES APPROVED UNAPPROVED REVIEW_STARTED
MergeRequest.changeRequesters :: UserCoreConnection
  — "Users that have requested changes to the merge request."
```

`changeRequesters` agreed exactly with the set of reviewers at `REQUESTED_CHANGES` on
every MR where both were selected `[LIVE]` — e.g. `gitlab-org/gitlab`!250822
`changeRequesters: [dstull]` against reviewers `dstull=REQUESTED_CHANGES`,
`GitLabDuo=REVIEWED`. It is the direct analogue of filtering
`latestOpinionatedReviews` to `CHANGES_REQUESTED`, and it is cheaper: one connection
instead of a scan over reviewer records.

Observed reviewState distribution over 227 reviewer records on the 100 most recently
updated open `gitlab-org/gitlab` MRs `[LIVE]`:
`UNREVIEWED 52, REVIEWED 92, APPROVED 68, UNAPPROVED 10, REVIEW_STARTED 2, REQUESTED_CHANGES 3`.

The GitHub mapping is not one-to-one. `REVIEWED` is *comment-only* — the same noise class
that forced 0005 onto `latestOpinionatedReviews`, and it is the single most common state.
GitLab's opinionated pair is `{APPROVED, REQUESTED_CHANGES}`; `UNAPPROVED` is a
*withdrawn* approval and is non-opinionated. `mergeRequestInteraction.reviewed` is **not**
"has reviewed": it was `false` on every `APPROVED` and `REQUESTED_CHANGES` record
observed, and `true` only for `REVIEWED` `[LIVE]`.

**The feature is tier-gated, and this is observable in the API.** "Prevent merge when you
request changes" is Tier: Premium, Ultimate `[DOCS]`
(https://docs.gitlab.com/user/project/merge_requests/reviews/#prevent-merge-when-you-request-changes),
introduced 16.11 behind `mr_reviewer_requests_changes`, flag removed 17.3. Live, the
gating shows up as a `null`-versus-empty distinction `[LIVE]`:

| Project | tier | `changeRequesters` on MRs with no change requesters |
| --- | --- | --- |
| `kesh-back` (6 MRs), `kesh-front` (2 MRs) | Free | **`null` on all 8** |
| `gitlab-org/gitlab` (12 sampled) | Ultimate | `{"nodes": []}` on all 12 |

`null` is therefore "this project cannot express a change request", not "nobody has
requested changes" — a genuine capability signal the seam can read per project, without
a settings endpoint that would 403. **Bucket 2 is structurally unreachable on the
driver's own projects.**

**Unresolved threads are a separate axis, not a substitute.** Available without any extra
request: `blocking_discussions_resolved` (REST list level), `mergeableDiscussionsState`,
`resolvableDiscussionsCount`, `resolvedDiscussionsCount` (GraphQL) `[LIVE]`. On
`gitlab-org/gitlab`!250688 the counts were `2/6` resolved with
`mergeableDiscussionsState: false`. These say "threads are open", which includes the
author's own questions and bot threads — strictly weaker than "a human blocked this". Use
them for readiness, not verdict.

**Verdict mapping.** Since GitLab reports no repository-wide decision, verdict must be
*composed*:

| CONTEXT.md verdict | GitLab derivation | Status |
| --- | --- | --- |
| `changes-requested` | `changeRequesters.nodes` non-empty | **derivable**, Premium+ (`null` on Free) |
| `approved` | `approvedBy.nodes` non-empty and `changeRequesters` empty | **derivable** |
| `awaiting-review` | `approvalsRequired > 0` and `approvedBy` empty | **derivable**, Premium+ — `approvalsRequired` is 0 on every Free project |
| `review-optional` | `approvalsRequired === 0` and `approvedBy` empty | **derivable** |

On Free tier the `awaiting-review`/`review-optional` distinction that 0005 fought to
preserve **collapses**: every MR is `review-optional`. That is not a defect in the
derivation, it is the true state of the driver's projects — nothing is being waited on
because nothing is required.

### 2. Standing — the viewer-relative axis

**No `viewer*` fields exist.** Introspection of `MergeRequest` (129 fields) returned
nothing matching `viewer` `[LIVE]`. Identity comes from `{ currentUser { username id } }`
→ `{"username":"ermandduro","id":"gid://gitlab/User/830730"}` `[LIVE]`, or REST
`GET /user` → `{"id":830730,"username":"ermandduro"}` `[LIVE]`. Same property as GitHub's
`viewer { login }`: read from the token, never configured.

The substitute is `UserMergeRequestInteraction`, reachable per reviewer. Introspected
verbatim `[LIVE]`:

```
UserMergeRequestInteraction (7 fields)
  applicableApprovalRules :: ApprovalRule
  approved                :: Boolean  — Whether the user has approved the merge request.
  canMerge                :: Boolean
  canUpdate               :: Boolean
  reviewState             :: MergeRequestReviewState — State of the review by the user.
  reviewed                :: Boolean  — Whether the user has provided a review for the merge request.
  updatedAt               :: Time     — Timestamp of when the reviewer was last updated.
                                        "null" for records that have not transitioned state since GitLab 19.2.
```

It hangs off `MergeRequestReviewer`
(`reviewers { nodes { username mergeRequestInteraction { … } } }`), so the viewer's own
record is found by `username === currentUser.username` — a client-side filter over data
already selected, exactly the shape 0005's amendment settled for
`latestOpinionatedReviews`. No extra request.

Consistency check `[LIVE]`: over 227 reviewer records on 100 MRs,
`mergeRequestInteraction.approved` agreed with `approvedBy` membership in **227/227**
cases. But `approvedBy` is the superset — a user can approve without being a reviewer,
observed once in 26 MRs carrying approvals `[LIVE]`. So `i-approved` must read
`approvedBy`, not `reviewers`. Symmetrically, `i-requested-changes` should read
`changeRequesters`, which is not restricted to the reviewer list either.

| CONTEXT.md standing | GitLab source | Status |
| --- | --- | --- |
| `mine` | `author.username === currentUser.username` (REST `author.id`) | **supported** |
| `awaiting-me` | my `reviewers[]` entry with `reviewState ∈ {UNREVIEWED, REVIEW_STARTED}`; REST equivalent `?scope=reviews_for_me` or `?reviewer_username=` | **derivable** |
| `i-requested-changes` | `changeRequesters.nodes` ∋ me | **derivable**, Premium+ |
| `i-approved` | `approvedBy.nodes` ∋ me | **derivable** |
| `i-commented` | my entry, `reviewState === "REVIEWED"` — **only if I am a reviewer** | **partial** — see below |
| `not-involved` | none of the above | **derivable** |

**`i-commented` is the one real hole.** `reviewState: REVIEWED` is set only for a user who
is on the reviewer list. Commenting on an MR you were never assigned to sets nothing on
the MR object; the only evidence is a note authored by you, and `Query.mergeRequests`
accepts no commenter filter — its full argument list, introspected `[LIVE]`, is:

```
approvedBy, releaseTag, iids, mergedBy, myReactionEmoji, or, sourceBranches,
targetBranches, state, draft, blobPath, closedAfter, closedBefore, createdAfter,
createdBefore, deployedAfter, deployedBefore, deploymentId, environmentName,
updatedAfter, updatedBefore, ignoredReviewerUsername, labelName, labels,
mergedAfter, mergedBefore, milestoneTitle, milestoneWildcardId, reviewState,
reviewStates, sort, subscribed, not, approver, assigneeUsername,
assigneeUsernames, assigneeWildcardId, authorUsername, reviewerUsername,
reviewerWildcardId, includeArchived, after, before, first, last
```

REST's `scope` accepts only `created_by_me`, `assigned_to_me`, `reviews_for_me`, `all`
`[DOCS]` (https://docs.gitlab.com/api/merge_requests/). There is no `involves:@me` and no
commenter qualifier. **GitLab has no analogue of the second half of the 0013 scan.**
Detecting `i-commented` for a non-reviewer would need a per-MR `discussions` fetch across
an unbounded candidate set, which is not a scan. Mark `i-commented` **impossible at scan
cost**; it degrades to `not-involved`, and those MRs never enter the set in the first
place.

**Sort keys.** `asCodeOwner` has no direct analogue: GitLab's Code Owner signal lives on
approval *rules*, not on the reviewer record —
`approvalState { rules { name type approvalsRequired approved approvedBy { nodes { username } } eligibleApprovers { username } } }`
returned
`{"name":"/db/","type":"CODE_OWNER","approvalsRequired":1,…,"eligibleApprovers":[32 users]}`
`[LIVE]`, in the same query as everything else. "This request reached me via CODEOWNERS"
is derivable as *my username appears in a `CODE_OWNER` rule's `eligibleApprovers`* — but
that is eligibility, not routing, and it is Premium+ (REST equivalent
`approval_state.rules[].rule_type === "code_owner"`, `[LIVE]` on
`gitlab-org/gitlab`!250822).

**GitLab is strictly better than GitHub on request timing.** 0005 established that
GitHub's `ReviewRequest` carries no timestamp, forcing bucket 1 to sort on PR `createdAt`
as a proxy. GitLab's `mergeRequestInteraction.updatedAt` **is** that timestamp, in the
same selection at no extra cost `[LIVE]` — e.g. `gitlab-org/gitlab`!250822 `dstull`
`updatedAt: 2026-08-19T10:30:45Z` against MR `createdAt: 2026-08-19T10:08:47Z`. Bucket 1's
proxy can be replaced with the real thing on the GitLab side.

**Re-request.** GitLab has no distinct "re-requested" state; the reviewer returns to
`UNREVIEWED` and `updatedAt` moves `[DOCS]`
(https://docs.gitlab.com/user/project/merge_requests/reviews/#re-request-a-review). Since
`awaiting-me` already absorbs the re-request case by precedence, the resulting value is
identical; only the *reason* is lost. Corroborating live signal: across 227 reviewer
records, **zero** users appeared in `approvedBy` with a `reviewState` other than
`APPROVED` `[LIVE]`.

### 3. Stale block — bucket 2, the sharpest question

**GitLab records no commit against a review state.** `UserMergeRequestInteraction` has
seven fields and none is a sha (introspected verbatim above, `[LIVE]`). `changeRequesters`
is a plain `UserCoreConnection` — usernames only, no timestamp and no sha `[LIVE]`. There
is no `PullRequestReview.commit.oid` analogue. The sha-equality test that `isStaleBlock`
uses in `src/domain.ts` **cannot be ported**.

Three candidate reconstructions, in descending honesty:

**(a) Timestamp against the last push — the only one that works at scan cost.**
`MergeRequest.mergeRequestDiffs` (GraphQL, "Introduced in GitLab 16.2: Status:
Experiment") exposes exactly two fields, `createdAt` and `updatedAt` `[LIVE]`, and returns
newest-first — verified 51/51 `[LIVE]`. A new diff version is created per push, so
`mergeRequestDiffs(first:1).nodes[0].createdAt` is the last push time. Because
`changeRequesters` carries no timestamp, the blocking-reviewer timestamp must come from
the matching `reviewers[]` record.

Measured over **all 58** open `gitlab-org/gitlab` MRs with a blocking reviewer `[LIVE]`
(`glab api graphql -f query='query { project(fullPath:"gitlab-org/gitlab") { mergeRequests(state: opened, reviewStates: [REQUESTED_CHANGES], first: 60) { count nodes { iid diffHeadSha reviewers { nodes { username mergeRequestInteraction { reviewState updatedAt } } } mergeRequestDiffs(first: 2) { nodes { createdAt } } } } } }'`):

| Outcome | Blocking-reviewer records |
| --- | --- |
| `updatedAt < lastPush` → **stale block** | 16 |
| `updatedAt ≥ lastPush` → unchanged | 32 |
| `updatedAt === null` → **undecidable** | 12 |

Sample rows:
`!250226 marcel.amirault block=2026-08-17T09:12:44Z lastPush=2026-08-17T16:20:36Z → STALE`;
`!249940 z_painter block=2026-08-14T15:44:20Z lastPush=2026-08-18T11:28:53Z → STALE`;
`!250822 dstull block=2026-08-19T10:30:45Z lastPush=2026-08-19T10:08:47Z → fresh`.

**The 12 nulls are the cost.** The schema says `null` is returned "for records that have
not transitioned state since GitLab 19.2" `[LIVE]`, i.e. old records. They concentrate in
the `REQUESTED_CHANGES` cohort precisely because a standing block is a state nobody has
touched in a while: 12/60 (20%) there, versus **1/227** across the 100 most recently
updated MRs `[LIVE]`. A dashboard cannot know whether those 12 belong in bucket 2 or
bucket 6.

0005's second amendment settled the analogous GitHub case — a blocking review with a
`null` commit resolves toward *stale*, because the alarming reading is the one that
surfaces action. The same argument applies verbatim here and is the only reading
consistent with the existing model.

**(b) Sha, via the blocking reviewer's diff notes.** A diff note carries the head it was
written against. REST `note.position`, verbatim `[LIVE]`
(`glab api "projects/gitlab-org%2Fgitlab/merge_requests/250822/notes?per_page=100&sort=asc"`):

```json
{"base_sha": "b1142cf324b65248003d7c0c64e4959a58772ba2",
 "start_sha": "b1142cf324b65248003d7c0c64e4959a58772ba2",
 "head_sha": "f5d60187b221646a850bcd89d549365bc08b9fdd",
 "old_path": ".gitlab/CODEOWNERS", "new_path": ".gitlab/CODEOWNERS",
 "position_type": "text", "old_line": 774, "new_line": 778, "line_range": {…}}
```

GraphQL equivalent: `Note.position { diffRefs { headSha startSha baseSha } }`, where
`DiffRefs.headSha` is documented "SHA of the HEAD at the time the comment was made"
`[LIVE]`. Comparing that against `MergeRequest.diffHeadSha` is a true sha-equality test —
the real GitHub analogue. Over 12 blocking MRs, 44 diff notes were anchored at the current
head and **35 at an older head** `[LIVE]`.

Two reasons it cannot be the primary: it needs a `discussions` sub-selection per MR (50
discussions × 12 MRs was already a visibly heavier query), and it only answers when the
blocking reviewer left a *diff* note — 77 user notes in that same sample had no `position`
at all. It is the right escalation for the ≤20% of records where (a) returns null, not the
default.

**(c) System notes — the true audit trail, at the highest cost.**
`Note.systemNoteMetadata { action }` returns machine-readable review events. Distribution
over the same 12 MRs `[LIVE]`:

```
reviewer 43, commit 34, cross_reference 17, description 15, assignee 12,
discussion 12, requested_changes 11, task 10, reviewed 6, approved 5,
title 5, duo_agent_started 2, branch 2, duo_agent_failed 1
```

`requested_changes`, `approved`, `reviewed` and `reviewer` each carry an author and a
`created_at`, and `commit` notes carry the pushed shas in their body
(`"added 1 commit\n\n<ul><li>eca4ffcf - fix: close review findings…"`, `[LIVE]` on
kesh-back!326). Interleaving them gives an exact answer. It is one request per MR plus
body parsing; out of scope for a scan.

REST `/versions` is the equivalent push timeline with shas, `[LIVE]` on kesh-back!326 —
keys
`base_commit_sha, created_at, head_commit_sha, id, merge_request_id, patch_id_sha, real_size, start_commit_sha, state`,
four versions from `cfcda9e5fc` (2026-07-18) to `eca4ffcf52` (2026-07-28). Also one
request per MR.

**Why the asymmetry matters.** A blocking review **survives a push** — live proof in five
of the sixteen stale rows above, where the author pushed hours or days after the block and
`reviewState` is still `REQUESTED_CHANGES`. An approval does **not**: "By default, an
approval on a merge request is removed when you add more changes after the approval",
using `git patch-id` to avoid resetting on a rebase that does not change the diff `[DOCS]`
(https://docs.gitlab.com/user/project/merge_requests/approvals/settings/#remove-all-approvals-when-commits-are-added-to-the-source-branch),
Tier: Premium, Ultimate. The project-level flag is readable as `reset_approvals_on_push` on
`GET /projects/:id/approvals` — kesh-back returned
`{"approvals_before_merge":0,"reset_approvals_on_push":false,"selective_code_owner_removals":false,"merge_requests_author_approval":false,…}`
`[LIVE]`, though on a Free project the whole settings feature is inert. The same endpoint
on `gitlab-org/gitlab` returned `{"message":"403 Forbidden"}` `[LIVE]` — it needs
Maintainer, so a dashboard **cannot** read this setting for projects it merely watches.

Consequence: GitLab has essentially no "stale approval" — the platform deletes it. It has
stale *blocks* in abundance. A GitHub port that assumes both kinds of review go stale the
same way will be wrong in both directions.

`approvals_before_merge` is a dead end: `null` on every MR observed `[LIVE]`, deprecated in
16.0 and scheduled for removal in API v5 `[DOCS]`
(https://docs.gitlab.com/api/merge_requests/).

### 4. Readiness — merge state and CI

**Enums, introspected verbatim `[LIVE]`:**

```
MergeStatus:         UNCHECKED CHECKING CAN_BE_MERGED CANNOT_BE_MERGED CANNOT_BE_MERGED_RECHECK
DetailedMergeStatus: UNCHECKED CHECKING MERGEABLE COMMITS_STATUS CI_MUST_PASS CI_STILL_RUNNING
                     DISCUSSIONS_NOT_RESOLVED DRAFT_STATUS NOT_OPEN NOT_APPROVED BLOCKED_STATUS
                     EXTERNAL_STATUS_CHECKS PREPARING JIRA_ASSOCIATION CONFLICT NEED_REBASE
                     APPROVALS_SYNCING LOCKED_PATHS LOCKED_LFS_FILES MERGE_TIME
                     SECURITY_POLICIES_VIOLATIONS TITLE_NOT_MATCHING REQUESTED_CHANGES
                     SECURITY_POLICY_PIPELINE_CHECK
PipelineStatusEnum:  CREATED WAITING_FOR_RESOURCE PREPARING WAITING_FOR_CALLBACK PENDING RUNNING
                     FAILED SUCCESS CANCELING CANCELED SKIPPED MANUAL SCHEDULED
```

The REST snake_case list matches, plus `merge_request_blocked`, `status_checks_must_pass`,
`title_regex`, `jira_association_missing`, `security_policy_violations` `[DOCS]`
(https://docs.gitlab.com/api/merge_requests/#merge-status). Note the enums are **not**
name-identical across the two APIs — GraphQL `JIRA_ASSOCIATION` / `TITLE_NOT_MATCHING` /
`SECURITY_POLICIES_VIOLATIONS` versus REST `jira_association_missing` / `title_regex` /
`security_policy_violations`.

**Map to `MergeState`.** `detailed_merge_status` mixes merge state with verdict and
lifecycle, so only a few of its 24 values are about mergeability:

| GitLab | `clean` / `conflicted` / `unknown` |
| --- | --- |
| `MERGEABLE` | `clean` |
| `CONFLICT`, `NEED_REBASE` | `conflicted` |
| `UNCHECKED`, `CHECKING`, `PREPARING`, `APPROVALS_SYNCING` | `unknown` |
| everything else (`CI_MUST_PASS`, `NOT_APPROVED`, `DRAFT_STATUS`, `REQUESTED_CHANGES`, `DISCUSSIONS_NOT_RESOLVED`, …) | `clean` — git can merge; another axis is blocking |

That last row is the load-bearing one. `gitlab-org/gitlab`!250822 reported
`merge_status: "can_be_merged"` **and** `detailed_merge_status: "requested_changes"`
simultaneously `[LIVE]`. Folding `detailed_merge_status !== mergeable` into `conflicted`
would push half the board into bucket 4.

Deprecated `merge_status` (since 15.6 `[DOCS]`) maps directly: `CAN_BE_MERGED → clean`,
`CANNOT_BE_MERGED → conflicted`, `UNCHECKED`/`CHECKING`/`CANNOT_BE_MERGED_RECHECK →
unknown`.

**Map to `Checks`.** From `headPipeline.status`:

| GitLab | `Checks` |
| --- | --- |
| `SUCCESS` | `success` |
| `FAILED` | `failing` |
| `CREATED`, `WAITING_FOR_RESOURCE`, `PREPARING`, `WAITING_FOR_CALLBACK`, `PENDING`, `RUNNING`, `SCHEDULED` | `pending` |
| `CANCELED`, `CANCELING`, `SKIPPED`, `MANUAL`, `headPipeline === null` | `none` |

`MANUAL` is the judgement call: a pipeline waiting on a manual gate is not failing and not
running. Mapping it to `pending` would pin an MR in bucket 5 forever, exactly the failure
0007's amendment fixed for GitHub; `none` is the reading consistent with that amendment.

`detailedStatus.name` carries values outside `PipelineStatusEnum` — `SUCCESS_WITH_WARNINGS`
with `label: "passed with warnings"` was observed while `status` was plain `SUCCESS`
`[LIVE]` (`gitlab-org/gitlab`!250553). It is typed `String`, not an enum, so it is
open-ended and must not be switched on. `DetailedStatus.text` is deprecated in 16.4 in
favour of `label` `[LIVE]`.

**Lazily or asynchronously computed fields — every one, named.**

1. **`merge_status` / `detailed_merge_status`.** "The mergeability (`merge_status`) of each
   merge request is checked asynchronously when a request is made to this endpoint. Poll
   this API endpoint to get the updated status." `[DOCS]`
   (https://docs.gitlab.com/api/merge_requests/#single-merge-request-response-notes).
   Live: **3 of the driver's 8 open MRs** sat at `UNCHECKED` (kesh-back!315,
   kesh-front!224) or `CANNOT_BE_MERGED_RECHECK` (kesh-back!285) `[LIVE]`. This is
   GitHub's `MergeableState.UNKNOWN` problem at **38% incidence** rather than
   first-sight-only. The list endpoint accepts `with_merge_status_recheck=true`, which
   "requests (but does not guarantee) an asynchronous recalculation" `[DOCS]` — it does not
   make the current response correct, and is ignored for users below Developer when
   `restrict_merge_status_recheck` is on.
2. **`has_conflicts`.** "Dependent on the `merge_status` property. Returns `false` unless
   `merge_status` is `cannot_be_merged`" `[DOCS]`. It is a *derivation*, not an
   observation. Live counter-example: kesh-back!285 reported `has_conflicts: false` with
   `detailed_merge_status: "conflict"` and `merge_status: "cannot_be_merged_recheck"`
   `[LIVE]`. **Never read `has_conflicts`/`conflicts`; read `detailed_merge_status`.**
3. **`head_pipeline`.** `null` observed on `gitlab-org/gitlab`!250515 while
   `pipelines(first:1)` on the same MR returned a `FAILED` pipeline `[LIVE]`. Also "Exposed
   only if the current user can view pipelines for this project" `[DOCS]`, so `null`
   conflates *no CI*, *not yet linked*, and *not permitted*. All three must render as
   `none`, never as failure — the same rule 0005 set for a null `statusCheckRollup`.
4. **`diff_refs` and `changes_count`.** "When you create a merge request, the `diff_refs`
   and `changes_count` fields are initially empty. These fields populate asynchronously
   after you create the merge request." `[DOCS]`
   (https://docs.gitlab.com/api/merge_requests/#empty-api-fields-for-new-merge-requests).
   `diff_refs.head_sha` is a head-commit source, so a brand-new MR can report no head at
   all.
5. **`prepared_at`.** `null` until *create the diff, create the pipelines, check
   mergeability, link LFS objects, send notifications* have all completed, and never
   updated afterwards `[DOCS]`. It is the one field that says "everything above has settled
   at least once" and is the honest gate for suppressing a spurious change report on a
   newly-seen MR.

**Do not compare `headPipeline.sha` to `diffHeadSha` to detect a stale pipeline.** With
merged-results pipelines the head pipeline runs on `refs/merge-requests/:iid/merge`, a
synthetic commit. Live: 0/4 matched on `gitlab-org/gitlab` (`head_pipeline.sha: "628b832…"`,
`ref: "refs/merge-requests/250822/merge"` against `sha: "f5d6018…"`), 8/8 matched on `kesh`,
which uses branch pipelines `[LIVE]`. The comparison would report every
`gitlab-org`-style MR as stale.

**`pipelines(first:1)` is not the head pipeline** and disagrees with it in both directions
— !250688 `headPipeline FAILED` vs `pipelines[0] SUCCESS`, !250553 `headPipeline SUCCESS`
vs `pipelines[0] FAILED` `[LIVE]`. REST `pipeline` is likewise documented "Consider using
`head_pipeline` instead" `[DOCS]`.

**The REST list endpoint carries no CI at all.** Full key set of a list-level MR `[LIVE]`
(`glab api "merge_requests?scope=created_by_me&state=opened&per_page=1"`) — `head_pipeline`
and `pipeline` are absent, appearing only on the single-MR endpoint. It *does* carry
`detailed_merge_status`, `merge_status`, `has_conflicts`, `blocking_discussions_resolved`,
`draft`, `work_in_progress`, `reviewers`, `assignees`, `sha`, `upvotes`/`downvotes`,
`approvals_before_merge`, `prepared_at`, `references`. So **readiness forces GraphQL**, or
N+1 REST calls.

### 5. Lifecycle — draft detection

`draft` and `work_in_progress` are the same value; `work_in_progress` is documented
"Deprecated. Use `draft` instead." `[DOCS]`. Live, all 8 of the driver's MRs: identical on
every one `[LIVE]`.

**The `WIP:` title prefix no longer marks a draft.** Decisive live evidence `[LIVE]`
(`glab api "merge_requests?scope=created_by_me&state=opened&per_page=20"`):

| MR | title prefix | `draft` | `work_in_progress` | `detailed_merge_status` |
| --- | --- | --- | --- | --- |
| kesh-back!323 | `Draft:` | `true` | `true` | `draft_status` |
| kesh-back!315 | `WIP:` | `false` | `false` | `unchecked` |
| kesh-front!224 | `WIP:` | `false` | `false` | `unchecked` |

The recognised prefixes are `[Draft]`, `Draft:`, `(Draft)` in a title, or `draft:`,
`Draft:`, `fixup!`, `Fixup!` at the start of a commit message `[DOCS]`
(https://docs.gitlab.com/user/project/merge_requests/drafts/). `WIP` is not among them.
**Read `draft`; never parse the title.** Two of the driver's eight MRs would be
misclassified by title parsing.

Corollary matching 0007: `draft` also surfaces as `detailed_merge_status: draft_status`,
which is why lifecycle must be stripped out of the readiness mapping rather than folded
into `conflicted`. Draft MRs run the same pipelines as ready ones `[DOCS]`, so `draft`
implies nothing about CI.

The list-level filter is `?draft=true|false` (introduced 19.0); `?wip=yes|no` is deprecated
as of 19.0 `[DOCS]`.

### 6. Stacks — 0010's premise is wrong, but the shape differs

**GitLab has a first-class `stack` field.** Introspected verbatim `[LIVE]`:

```
MergeRequest.stack :: [MergeRequest]  (no arguments)
  "Other open merge requests in the same stack as this merge request, ordered from the
   top of the stack to the bottom. Returns null if this merge request is not part of a
   stack, or if the stack contains more than 20 merge requests."
```

It is populated, common, and available on Free tier. Live incidence over open MRs `[LIVE]`
(`glab api graphql -f query='query { project(fullPath:"<p>"){ mergeRequests(state:opened, first:100, sort: UPDATED_DESC){ count nodes { iid stack { iid state } } } } }'`):

| Project | sampled | `null` | `[]` | non-empty |
| --- | --- | --- | --- | --- |
| `gitlab-org/gitlab` | 100 of 3057 | 0 | 76 | **24** |
| `gitlab-org/cli` | 56 of 56 | 0 | 32 | **24** |
| `gitlab-org/gitaly` | 64 of 64 | 0 | 52 | **12** |
| `gitlab-org/gitlab-development-kit` | 26 of 26 | 0 | 26 | 0 |
| `kesh-back` + `kesh-front` | 8 of 8 | 0 | 8 | 0 |

Six corrections to the field's own description, all observed:

1. **It includes self, despite saying "Other".** Self appeared in the array in **24/24**
   non-empty `gitlab-org/cli` stacks `[LIVE]`; e.g. `gitlab-org/gitlab`!250821 returns
   `[250227, 250805, 250809, 250821, 250824, 250838, 250843]`. This is what makes
   `position` and `size` derivable at all: `size = stack.length`,
   `position = stack.findIndex(m => m.iid === self.iid) + 1`.
2. **It returns `[]`, not `null`, when the MR is not stacked** — 0 nulls across 246
   sampled MRs `[LIVE]`. The `null` cases documented (not stacked, or >20 members) were
   never observed; treat `null` as reachable but rare.
3. **It is a path, not a partition.** CONTEXT.md states "A PR is either in exactly one
   stack or in none." That is **false** on GitLab. Decisive live counter-example in
   `gitlab-org/gitaly` `[LIVE]`:

   | MR | branch | reported `stack` |
   | --- | --- | --- |
   | !8812 | `poc/scaling-git → master` | `[8812, 8821]` |
   | !8821 | `adapt-gitaly-mr-8757-to-scaling-git → poc/scaling-git` | `[8812, 8821]` |
   | !9094 | `sh-mvcc-publish-instrumentation → poc/scaling-git` | `[8812, 9094]` |
   | !8918 | `sh-mvcc-stats-reftables → poc/scaling-git` | `[8812, 8918]` |

   !8812 is a member of **three different stacks** simultaneously. Three MRs branch off
   the same base, and GitLab reports each as its own linear chain `[base, self]` rather
   than merging the siblings. A "stack" is the ancestry path from one MR down to the
   trunk, computed per MR. Any renderer that assumes one stack row per stack will draw
   !8812 three times.

   The relation is not merely non-partitioning, it is **not symmetric**: `stack(9094)`
   contains `8812`, but `stack(8812)` does **not** contain `9094` `[LIVE]`. So
   `A ∈ stack(B)` does not imply `B ∈ stack(A)`, and a global stack graph cannot be
   reconstructed by unioning per-MR stacks. The practical consequence is sharper than
   "differently shaped": every stack field in the shared model must be **per-MR**
   (position, depth). A stack *identity* like GitHub's `stack { number }` is not
   derivable at all — there is no object for it to name. Established jointly with
   GitLabApiScout; see [0019](0019-gitlab-mr-api.md).
4. **The ordering is bottom-up, and the description has it backwards.** The field says
   "ordered from the top of the stack to the bottom". Live, on two independent stacks, the
   array is a perfectly chained linear sequence where `element[i].sourceBranch ===
   element[i+1].targetBranch`, and `element[0]` targets a branch outside the stack — the
   trunk `[LIVE]`:

   ```
   gitlab-org/cli!3744, 6 members            gitlab-org/gitlab!250821, 7 members
   [0] !3744  df-mr-03a-policy-core -> main  [0] !250227  …add-flow-schedules-table -> master
   [1] !3745  df-mr-03b-cache -> df-mr-03a…  [1] !250805  …flow-triggers-identity   -> …add-flow-schedules-table
   [2] !3746  df-mr-03c-rest  -> df-mr-03b…  [2] !250809  …flow-schedule-model      -> …flow-triggers-identity
   [3] !3741  df-mr-04-proxy  -> df-mr-03c…  [3] !250821  …flow-schedules-crud      -> …flow-schedule-model
   [4] !3742  df-mr-05-fsx    -> df-mr-04…   [4] !250824  …flow-schedule-notifs     -> …flow-schedules-crud
   [5] !3743  df-mr-06-pm-core-> df-mr-05…   [5] !250838  …flow-schedule-execution  -> …flow-schedule-notifs
                                             [6] !250843  …flow-schedules-frontend  -> …flow-schedule-execution
   ```

   Index 0 is the layer **closest to the trunk**; the index increases going *up* the
   stack. So `position = indexOf(self) + 1` counts from the bottom, which is exactly
   CONTEXT.md's reading of *Position* — the right answer reached in spite of the
   documentation, not because of it. The chain invariant is also a cheap runtime
   assertion: if `element[i].sourceBranch !== element[i+1].targetBranch`, the ordering
   assumption has changed underneath us.

5. **It is one root-to-tip path through a *tree*, so the array length is not the stack's
   size.** Where the chain forks above you, the API returns one branch and silently drops
   the others. Live in `gitlab-org/cli`: nine open MRs all report root !3253, with three
   fork points — !3254 → {3255, 3259}, !3256 → {3257, 3261}, !3257 → {3258, 3260} `[LIVE]`.
   Asking different members of that one family returns different arrays:

   ```
   asked !3253  len=6 pos=1  [3253, 3254, 3255, 3256, 3257, 3258]
   asked !3257  len=6 pos=5  [3253, 3254, 3255, 3256, 3257, 3258]
   asked !3261  len=5 pos=5  [3253, 3254, 3255, 3256, 3261]
   asked !3259  len=3 pos=3  [3253, 3254, 3259]
   asked !3260  len=6 pos=6  [3253, 3254, 3255, 3256, 3257, 3260]
   ```

   Three distinct lengths — 3, 5, 6 — for a family of **9**. Even the root reports 6.

   **Position is nevertheless trustworthy, by construction rather than by luck.** The
   *trunk-ward prefix* is unambiguous, because however many branches sprout upward there
   is exactly one path back down to the trunk. Tested across all 6 stacked families in
   `gitlab-org/cli` — **57 prefix pairs, 0 inclusion violations** `[LIVE]`: for any two
   members, one prefix is always a prefix of the other. The 3 equal-depth ties are
   exactly the 3 fork points (`3254`, `3256`, `3257`), where two siblings share an
   identical prefix — which is the invariant holding, not an exception to it.
   `indexOf(self)` is therefore stable across queriers; `stack.length` is not.

   This is an **independent** reason from correction 6 for the same conclusion: even a
   stack with no merged layers at all still has no reportable size.

   **What to render instead of `n/m`.** The instinct is to degrade — a bare `#4`, or drop
   the column on GitLab. Better: read `indexOf(self)` as **depth from the trunk** rather
   than as position-within-a-set. Depth is a well-defined per-MR quantity that survives
   every defect found here — it needs no denominator, it is stable across queriers by the
   nesting result above, and it is untouched by merged layers dropping out because those
   were never counted in it. So `depth 3` is honest where `3/6` is not, and it needs
   neither a capability probe nor a conditional column. The GitHub side can keep
   reporting `5/6`; the two are different quantities and should not be forced into one
   field. Established jointly with GitLabApiScout; see [0019](0019-gitlab-mr-api.md).

6. **It is open-only.** All 107 stack members observed across `gitlab-org/cli` were
   `state: "opened"` `[LIVE]`, matching the "Other **open** merge requests" wording.
   CONTEXT.md's *Position*/*Size* explicitly "count already-merged layers, so a partly
   landed stack still reports `5/6`". GitLab's cannot: as each layer lands, both position
   and size shrink. **`5/6` has no GitLab equivalent** — the numbers are of a different
   kind, not merely a different source.

There is also **no stack identity**. GitHub has `stack { number size }`; GitLab has only
the member list, so `PullRequest.stack.number` has no source and the ordering key would
have to be synthesised from the member iids.

Separately, **merge request dependencies** are a distinct Premium feature and *not* the
stack analogue `[DOCS]`
(https://docs.gitlab.com/user/project/merge_requests/dependencies/). Live endpoints
`GET /projects/:id/merge_requests/:iid/blocks` and `/blockees` both exist and returned `[]`
on kesh-back!326 and `gitlab-org/gitlab`!250688/!250822 `[LIVE]`; a deliberately bogus
sibling path returned `{"error":"404 Not Found"}`, proving the empty arrays are real
answers. They are an unordered, cross-project blocker set (≤10 each way), surfacing in the
shared model only as `detailed_merge_status: merge_request_blocked`.

## Field-by-field mapping table

| Axis / field (`CONTEXT.md`) | GitHub source | GitLab source | Verdict |
| --- | --- | --- | --- |
| **Verdict** (whole axis) | `reviewDecision` | — no single field — | **derivable**, composed from three sources |
| verdict `changes-requested` | `CHANGES_REQUESTED` | `changeRequesters.nodes` non-empty | **supported**, Premium+ (`null` on Free) |
| verdict `approved` | `APPROVED` | `approvedBy.nodes` non-empty | **derivable** — `approved` is unusable |
| verdict `awaiting-review` | `REVIEW_REQUIRED` | `approvalsRequired > 0` ∧ no approvals | **derivable**, Premium+ only |
| verdict `review-optional` | `null` | `approvalsRequired === 0` ∧ no approvals | **supported** |
| **Standing** `mine` | `viewerDidAuthor` | `author.username === currentUser.username` | **derivable** |
| standing `awaiting-me` | `viewerLatestReviewRequest` | my `reviewers[]` entry, `reviewState ∈ {UNREVIEWED, REVIEW_STARTED}` | **derivable** |
| standing `i-requested-changes` | `latestOpinionatedReviews` ∩ viewer | `changeRequesters.nodes` ∋ me | **derivable**, Premium+ |
| standing `i-approved` | `latestOpinionatedReviews` ∩ viewer | `approvedBy.nodes` ∋ me | **derivable** |
| standing `i-commented` | `viewerLatestReview` | `reviewState === REVIEWED` **only if I am a reviewer** | **impossible** for non-reviewers at scan cost |
| standing `not-involved` | fallthrough | fallthrough | **supported** |
| `viaCodeOwners` | `ReviewRequest.asCodeOwner` | `approvalState.rules[] {type: CODE_OWNER}` ∋ me in `eligibleApprovers` | **derivable**, Premium+; semantics differ (eligibility ≠ routing) |
| review-request timestamp | **absent on GitHub** | `mergeRequestInteraction.updatedAt` | **supported** — better than GitHub |
| **`staleBlock`** | `review.commit.oid ≠ headRefOid` | `mergeRequestInteraction.updatedAt < mergeRequestDiffs(first:1)[0].createdAt` | **derivable by timestamp only**; ~20% `null` in the blocking cohort |
| stale block, sha-exact | `review.commit.oid` | `Note.position.diffRefs.headSha` vs `diffHeadSha` | **derivable**, one request per MR, diff notes only |
| **`merge`** `clean`/`conflicted`/`unknown` | `mergeable` | `detailedMergeStatus` (**not** `conflicts`) | **supported**, lazy |
| **`checks`** | `statusCheckRollup.state` | `headPipeline.status` | **supported**, lazy + permission-gated, GraphQL only |
| **`draft`** | `isDraft` | `draft` | **supported** |
| `headOid` | `headRefOid` | `diffHeadSha` / REST `sha` | **supported**, async on new MRs |
| `baseRef` | `baseRefName` | `targetBranch` / REST `target_branch` | **supported** |
| `repo` | `nameWithOwner` | `project.fullPath` / REST `references.full` | **supported** — depth ≥ 3, not `owner/name` |
| `number` | `number` | `iid` (a **string** in GraphQL) | **supported** |
| `url` | `url` | `webUrl` / REST `web_url` | **supported** |
| `otherReviews` | opinionated reviews ∖ viewer | (`approvedBy` ∪ `changeRequesters`) ∖ me | **derivable** |
| **stack membership** | `stack` | `stack` (list of member MRs, includes self) | **supported** |
| **stack `position`** | `stackEntry.position` (counts merged) | `indexOf(self)` read as **depth from trunk** — trunk-ward prefix proven unambiguous | **derivable** as depth; not as position-within-a-set |
| **stack `size`** | `stack.size` (counts merged) | — none — `stack.length` is querier-dependent (3, 5 or 6 for one 9-MR family) | **impossible** |
| **stack identity (`number`)** | `stack.number` | — nothing — | **impossible** |
| **"exactly one stack per MR"** | invariant holds | invariant **violated** — !8812 in 3 stacks | **impossible** to preserve |

Two shared-model fields need widening for a GitLab implementation: `repo` is validated as
`owner/name` by `REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/` in `src/query.ts`, which rejects
`albanian-technology-distribution/kesh/kesh-back` outright; and `number` is `number` in the
model but `iid` is a `String` in GitLab's GraphQL schema `[LIVE]`.

## The GitLab-side selection that answers every axis

Verified live against both of the driver's projects and against `gitlab-org/gitlab`, one
request per project `[LIVE]`:

```graphql
query { currentUser { username }
  project(fullPath: "…") { fullPath
    mergeRequests(state: opened, first: 20) { count nodes {
      iid title draft conflicts mergeStatusEnum detailedMergeStatus
      approved approvalsRequired approvalsLeft approvedBy { nodes { username } }
      changeRequesters { nodes { username } }
      author { username } diffHeadSha createdAt updatedAt webUrl
      headPipeline { status sha detailedStatus { name label } }
      reviewers { nodes { username
        mergeRequestInteraction { reviewState approved reviewed updatedAt } } }
      resolvableDiscussionsCount resolvedDiscussionsCount mergeableDiscussionsState
      mergeRequestDiffs(first: 1) { nodes { createdAt } }
      stack { iid state }
    } } } }
```

Result on kesh-back (6 MRs) and kesh-front (2), abridged `[LIVE]`:

```
!326 draft=False conflicts=True  mergeStatus=CANNOT_BE_MERGED         detailed=CONFLICT     approved=False req=0 left=0 changeRequesters=null stack=[] ci=('SUCCESS','SUCCESS',shaMatchesHead=True)
!323 draft=True  conflicts=True  mergeStatus=CANNOT_BE_MERGED         detailed=DRAFT_STATUS approved=False req=0 left=0 changeRequesters=null stack=[] ci=('FAILED','FAILED',shaMatchesHead=True)
!315 draft=False conflicts=False mergeStatus=UNCHECKED                detailed=UNCHECKED    approved=False req=0 left=0 changeRequesters=null stack=[] ci=('SUCCESS','SUCCESS',shaMatchesHead=True)
!285 draft=False conflicts=False mergeStatus=CANNOT_BE_MERGED_RECHECK detailed=CONFLICT     approved=False req=0 left=0 changeRequesters=null stack=[] ci=('SUCCESS','SUCCESS',shaMatchesHead=True)
!236 draft=False conflicts=False mergeStatus=CAN_BE_MERGED            detailed=MERGEABLE    approved=False req=0 left=0 changeRequesters=null stack=[] ci=('SUCCESS','SUCCESS',shaMatchesHead=True)
```

The same query run verbatim against `gitlab-org/cli` (Ultimate, 56 open MRs) resolves
every axis including stack position `[LIVE]`:

```
!3748 detailed=DISCUSSIONS_NOT_RESOLVED approvedBy=[]                      changeRequesters=[] reviewers=[phikai=UNREVIEWED, viktomas=UNREVIEWED, …, GitLabDuo=REVIEWED] ci=SUCCESS stack=None/0
!3746 detailed=NOT_APPROVED             approvedBy=[]                      changeRequesters=[] reviewers=[GitLabDuo=REVIEWED]                                            ci=SUCCESS stack=3/6
!3745 detailed=NOT_APPROVED             approvedBy=[]                      changeRequesters=[] reviewers=[GitLabDuo=REVIEWED]                                            ci=SUCCESS stack=2/6
!3744 detailed=DISCUSSIONS_NOT_RESOLVED approvedBy=[jhebden, timofurrer]   changeRequesters=[] reviewers=[jhebden=APPROVED, timofurrer=APPROVED, GitLabDuo=REVIEWED]      ci=SUCCESS stack=1/6
```

`stack=n/m` is computed as `indexOf(self) + 1` over the returned member list, confirming
the self-inclusion finding in section 6. Note !3744: two approvals, yet
`detailedMergeStatus: DISCUSSIONS_NOT_RESOLVED` — a live instance of the "another axis is
blocking, git can still merge" row of the merge-state table, which maps to `clean`.

Note `!285`: `conflicts=False` alongside `detailed=CONFLICT` — the `has_conflicts`
derivation failing in the driver's own data. And `changeRequesters=null` on every row —
the Free-tier capability signal.

Rate limiting, from response headers `[LIVE]` (`glab api graphql … --include`):
`Ratelimit-Limit: 2000`, `Ratelimit-Name: throttle_authenticated_api`,
`Ratelimit-Observed: 20`, `Ratelimit-Remaining: 1980`. There is no GraphQL query-cost field
of the kind GitHub's `rateLimit { cost }` provides.

## Two porting traps in GitLab's GraphQL

**`commits(last: 1)` is the oldest commit, not the newest.** Over the same 40 MRs `[LIVE]`:
`commits(first:1).sha === diffHeadSha` in **40/40**; `commits(last:1).sha === diffHeadSha`
in **14/40** — the 14 being single-commit MRs where the two coincide. `src/query.ts`
selects `commits(last: 1)` for the GitHub check rollup, so the idiom transfers wrongly and
*silently*, degrading to correct on exactly the MRs least likely to be noticed.

**`Commit.committedDate` is not UTC-normalised.** Observed values include
`2026-08-19T12:06:29+02:00`, `2026-08-18T15:27:38-07:00`, `2026-08-18T21:26:13+10:00`
`[LIVE]`. `compareWithin` in `src/domain.ts` orders by raw string comparison, valid for
GitHub's uniform `Z` suffix and wrong here. MR-level `createdAt`/`updatedAt` and
`mergeRequestDiffs.createdAt` **are** `Z`-suffixed `[LIVE]`, so only the commit-derived
timestamps are affected — which is precisely where a naive stale-block implementation would
reach.

## Open gaps

- **The driver's account cannot exercise any viewer-relative axis.**
  `?scope=reviews_for_me&state=opened` returns `[]` `[LIVE]`, and all 8 MRs have
  `reviewers: []` and `assignees: []`. Every `awaiting-me` / `i-requested-changes` /
  `i-approved` claim is derived from `gitlab-org` reviewer records observed from
  ermandduro's token — correct field semantics, but with ermandduro never being the
  subject. The mapping is unproven end to end and will stay unproven until a GitLab account
  with real review requests exists. GitLabApiScout independently reports that every
  reviewer-side *filter* also returns 0 against this account, so filters are unproven too;
  only the *fields* are established.
- **Bucket 2 is unreachable on the driver's own projects, and this is now measured rather
  than inferred.** `changeRequesters: null` on all 8 Free-tier MRs versus `{"nodes":[]}` on
  Ultimate MRs with no change requesters `[LIVE]`. Not established: whether a Free-tier
  reviewer can set `reviewState: REQUESTED_CHANGES` at all while `changeRequesters` stays
  `null`, or whether the state is refused outright. Both readings make bucket 2 empty for
  the driver; they differ only in whether `reviewers[].reviewState` remains a usable
  fallback.
- **Why 12 of 60 blocking records have a `null` `updatedAt` is not fully explained.** The
  schema attributes it to records that have not transitioned since 19.2, and the incidence
  gap between cohorts (12/60 in `REQUESTED_CHANGES`, 1/227 in the most-recently-updated
  100) is consistent with that. Not established: whether the null is permanent for those
  records or heals on the next transition. If permanent, a fraction of bucket 2 is
  undecidable forever.
- **`reset_approvals_on_push` is unreadable for watched projects.**
  `GET /projects/:id/approvals` returned `403 Forbidden` on `gitlab-org/gitlab` `[LIVE]`; it
  needs Maintainer. A dashboard therefore cannot know whether a given project resets
  approvals on push, so it cannot know whether an absent approval means "never approved" or
  "approved and then reset". Affects the approval half of verdict, not the block half.
- ~~Stack ordering direction~~ — **settled**, see section 6 correction 4. The array is
  bottom-up (index 0 nearest the trunk), verified by branch chaining on two independent
  stacks; the field's own description is backwards. Recorded here only because it was an
  open question for most of this investigation and the documentation still contradicts
  the observation.
- ~~What the renderer shows without a denominator~~ — **resolved**, see section 6. The
  answer is to render *depth*, a different and correct quantity, rather than a degraded
  `n/m`. Recorded as closed because it was live for part of this investigation.
- **The `null` branches of `stack` were never observed.** 0 nulls in 246 sampled MRs
  `[LIVE]`. The documented ">20 members returns null" case in particular means a large
  stack degrades to *no stack at all* rather than to a truncated one — untested, and it
  would silently drop the exact stacks most worth showing.
- **Cost and paging are deliberately not measured here.** The selection above was run per
  project; scan breadth, project identity and paging belong to
  [0019](0019-gitlab-mr-api.md). Ratelimit headers are recorded above only as context.
- **`MergeRequestDiff` is flagged "Introduced in GitLab 16.2: Status: Experiment"**
  `[LIVE]`. The primary stale-block primitive rests on an experimental field exposing two
  timestamps. REST `/versions` is the stable fallback but costs one request per MR.
- **`UNAPPROVED` does not distinguish "withdrew approval" from "approval was reset by a
  push".** 10 records observed `[LIVE]`; both readings are non-opinionated so the standing
  derivation is unaffected, but a UI that wanted to say "your approval was reset" cannot.
