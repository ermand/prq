# PR Review Dashboard

A read-only terminal UI that scans a saved list of GitHub repositories and
presents every open pull request, grouped by how much it concerns you.

## Language

### The axes

A PR's state is four independent axes plus its stack membership. Collapsing them
into one "status" is the mistake this vocabulary exists to prevent.

**Verdict**:
The repository's collective decision on a PR, as GitHub computes it. Exactly one
of `approved`, `changes-requested`, `awaiting-review`, `review-optional`. Says
nothing about you.
_Avoid_: status, review status, state

**Standing**:
Your own relationship to a PR — whether it is yours, whether the ball is in your
court, and what you last said about it. Exactly one value; see below.
_Avoid_: my status, involvement, relevance

**Readiness**:
Whether a PR could move if someone said yes: its check state and its merge state,
tracked separately.
_Avoid_: health, mergeability

**Lifecycle**:
Whether a PR is `draft` or `ready`. Drafts are shown, de-emphasised.

### Verdict values

**approved**: At least one opinionated review approves and none requests changes.
**changes-requested**: An opinionated review requests changes.
**awaiting-review**: The repository requires review and none has been submitted.
**review-optional**: The repository does not require review and none has been
submitted. Distinct from `awaiting-review` — nobody is being waited on.

### Standing values

Exactly one applies, resolved in this order — the first match wins.

**mine**: You opened the PR. Beats everything; you cannot review your own work.
**awaiting-me**: A review has been requested of you and you have not answered it.
Includes the re-request case, where you reviewed, the author pushed, and asked
again — the ball is back in your court, so this beats any prior verdict of yours.
**i-requested-changes**: Your latest *opinionated* review requested changes and no
new request is outstanding. Read from the opinionated reviews, never from your
latest review — a later comment of yours does not withdraw a block.
**i-approved**: Your latest opinionated review approved.
**i-commented**: You reviewed but never formed an opinion — a comment-only
review with no opinionated counterpart.
**not-involved**: None of the above.

### Cross-cutting terms

**Opinionated review**:
A review that approved or requested changes. Excludes comment-only and pending
reviews, which is what makes it the right basis for "has anyone actually reviewed
this" — bot reviewers routinely leave comment-only reviews.
_Avoid_: review (unqualified)

**Stale review**:
A review submitted against a commit that is no longer the PR's head. The opinion
stands on the record but no longer describes the current code.
_Avoid_: outdated, dismissed — `dismissed` is a distinct GitHub state

**Scan**:
One pass that refreshes every PR's state. Two parallel searches scoped to the
saved repositories — the review queue and everything else you touch — unioned.
Not a walk over the repository list.
_Avoid_: fetch, sync, poll

**Bucket**:
One of the seven ordered groups the dashboard renders, derived from standing and
refined by readiness. A PR belongs to exactly one, resolved first-match-wins.
Empty buckets render nothing.
_Avoid_: group, section, category

**Stale block**:
A changes-request of yours whose commit is no longer the PR's head — the author
has pushed since. The dashboard's most actionable state, because the author is
waiting on you and cannot tell.

**Stack**:
An ordered chain of dependent PRs, each based on the one below. Membership is what
the API reports, never what the description claims.

The two providers disagree on its shape, and the glossary cannot yet say which
meaning wins — that is [0021](.wayfinder/tickets/0021-gitlab-state-mapping.md).
On **GitHub** a PR is in exactly one stack or none, and the stack has an identity
and a number. On **GitLab** `MergeRequest.stack` is a *path*, not a partition: one
MR can legitimately belong to several stacks at once, it counts only open layers,
and there is no stack identity.

**Position** / **Size**:
A PR's 1-based place in its stack, and the stack's total length. On GitHub both
count already-merged layers, so a partly-landed stack still reports `5/6`. GitLab
counts open layers only and so cannot express that.

**Provider**:
The forge a row came from — GitHub or GitLab. Each has its own viewer, its own
credential, and its own baseline; a change diff never spans two.
_Avoid_: host, remote, source

**Viewer**:
The authenticated account the dashboard speaks for on a given provider — the
answer to "me". Read from the provider, never configured, and never compared
across providers.
_Avoid_: user, me, current user

**Precision**:
How well a provider filled a field, carried on the row rather than assumed from
the provider. `exact` is a direct answer; `approximate` is the best available
proxy; absent means the provider could not tell. It rides on the row because
capability is **per-project**, not per-provider — a blocking review is reportable
on a paid GitLab project and invisible on a free one, in the same scan.
_Avoid_: confidence, quality, fidelity
