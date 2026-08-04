---
id: 0002
title: The shape of the GitHub Pull Request Stacks API
parent: map
type: research
status: closed
assignee: Main
blocked_by: []
---

## Question

What exactly does GitHub's Pull Request Stacks API expose to a read-only
consumer, and how do we get at it from `gh`?

Pull Request Stacks entered public preview on 2026-07-30. Establish:

- The REST endpoints for listing stacks in a repo and getting one stack, with
  their exact response shape. Whether a preview `Accept` header or feature flag
  is required.
- The `stack` object on the pull request resource: which fields it carries
  (membership, stack number, size, position, base) and whether it appears on
  list responses or only on a single-PR fetch.
- The GraphQL read fields for stacks, and whether they can be selected inside a
  `pullRequests` connection — i.e. can one query return every open PR *and* its
  stack position in a single round trip.
- Whether `gh pr list --json` surfaces any stack field at the version installed
  here (2.96.0), or whether `gh api` is required.
- What a stack looks like once partially merged, and what the API reports for a
  PR whose base was retargeted by an automatic rebase.
- Whether stacks are observable on repos you do not own, and whether the
  preview is enabled per-repo, per-org, or globally.

Verify against the live API where possible rather than relying on the changelog
post. If the preview is not enabled for any repo reachable from this account,
say so plainly — that is itself the answer, and it changes the plan.

## Resolution

Findings: [0002-stacks-api-shape.md](../research/0002-stacks-api-shape.md)
(671 lines). Live GraphQL verification, which that file could not perform, is in
[0001b-graphql-query-budget.md](../research/0001b-graphql-query-budget.md).

**Stacks are readable today with no ceremony.** `GET /repos/{owner}/{repo}/stacks`
and `/stacks/{stack_number}` return 200 with no preview `Accept` header, no API
version pin and no opt-in — verified against `cli/cli`, `github/gh-stack` and
`rust-lang/rust`, none of them owned by this account. The preview is not gated
per-repo or per-org for reads.

**Membership rides on the PR list response**, so there is no N+1 and no second
endpoint. The exact shape, quoted live:
`stack: { id, number, base: { ref, sha }, size, position }`. The key is **omitted
entirely** when a PR is not in a stack, never `null` — absence is the membership
test. Beware that PR prose claiming "this is a stacked PR" is not membership;
one such PR returned `[]` from the stacks endpoint.

**`position` is 1-based from the base branch and counts merged PRs; `size` never
shrinks.** A 6-PR stack with 4 merged still reports position 5/6 and 6/6.
`open` on a stack means "has unmerged layers", not "nothing landed". `state` and
`merged_at` are independent — closed-but-unmerged PRs remain in the array, so
consumers must test `merged_at`.

**GraphQL exposes `PullRequest.stack` and `PullRequest.stackEntry`**, typed
`PullRequestStack { baseRefName, entries, id, number, size }` and
`PullRequestStackEntry { id, position, pullRequest, stack }`. Both are plain
nullable fields, and both were **verified live** as selectable inside a
`repository.pullRequests` connection: `cli/cli` #14013 returned
`stack { number: 14025, size: 6, baseRefName: "trunk" }, stackEntry { position: 5 }`
at cost 1 for 30 PRs. One round trip gets every open PR *and* its stack position.

**Automatic retargeting is invisible.** PR #14013's base silently became `trunk`
once the layer below merged, and nothing in the API marks it — no flag, no
timestamp, no change to `position` or `size`, only `base.ref` itself. Any UI that
wants to show "this was rebased under you" must diff against its own prior scan.

**`gh pr list --json` has no stack field at 2.96.0**; `gh api` is mandatory.
The `github/gh-stack` extension's only read command is local-checkout scoped
(issue #150 asking for `gh stack list` is still open), so it is not worth
shelling out to.

**Stacks are rare in the wild.** 2 of 30 open `cli/cli` PRs carried one; 0 of 30
in `golang/go`. The stack treatment must degrade gracefully to nothing.
