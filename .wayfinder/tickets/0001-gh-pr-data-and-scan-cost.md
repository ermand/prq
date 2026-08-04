---
id: 0001
title: What PR data gh can return, and what a scan costs
parent: map
type: research
status: open
assignee: ~
blocked_by: []
---

## Question

What can we actually observe about an open PR through `gh`, and what does
scanning a list of repos cost in requests and wall-clock time?

Establish, against the real authenticated CLI (`gh` 2.96.0, account **ermand**):

- The full set of `gh pr list --json` fields, and which of them carry:
  review decision, individual reviews and their authors/states, requested
  reviewers, CI check rollup, mergeable/conflict state, draft flag, timestamps,
  author, labels, base and head branch.
- Whether "someone else has already reviewed" and "I have already reviewed" are
  derivable from a list query alone, or need a per-PR follow-up. Note that a
  reviewer can review more than once — establish whether the API gives latest
  state per reviewer or a full history.
- Whether a single GraphQL query can span several repos at once, and if so
  whether `gh api graphql` can issue it. Compare against N sequential
  `gh pr list` invocations.
- The request cost and measured wall-clock time of one scan of ~10 repos, both
  ways. Include rate-limit headroom under a `repo`-scoped token.
- Process cost: is shelling out to `gh` per repo acceptable, or does the volume
  argue for hitting the API directly with the token `gh auth token` yields?

Deliver concrete evidence — real command invocations and real output shapes, not
documentation summaries. Redact repo and org names if they are private.
