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
**i-requested-changes**: Your latest review requested changes and no new request
is outstanding.
**i-approved**: Your latest review approved.
**i-commented**: Your latest review only commented — an opinion-free review.
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
One pass over the saved repository list that refreshes every PR's state.
_Avoid_: fetch, sync, poll

**Stack**:
GitHub's first-class ordered chain of dependent PRs, each based on the one below.
A PR is either in exactly one stack or in none. Not to be confused with a branch
chain that merely looks like one — membership is what the API reports, not what
the PR description claims.

**Position** / **Size**:
A PR's 1-based place in its stack, and the stack's total length. Both count
already-merged layers, so a partly-landed stack still reports `5/6`.

**Viewer**:
The authenticated GitHub account the dashboard speaks for — the answer to "me".
Read from the API, never configured.
_Avoid_: user, me, current user
