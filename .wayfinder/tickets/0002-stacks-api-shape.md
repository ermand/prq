---
id: 0002
title: The shape of the GitHub Pull Request Stacks API
parent: map
type: research
status: open
assignee: ~
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
