---
id: 0007
title: Relevance buckets and sort order
parent: map
type: grilling
status: open
assignee: ~
blocked_by: [0005]
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
