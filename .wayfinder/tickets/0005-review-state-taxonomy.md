---
id: 0005
title: The PR review-state taxonomy
parent: map
type: grilling
status: open
assignee: ~
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
