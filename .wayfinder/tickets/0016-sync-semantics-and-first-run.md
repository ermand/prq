---
id: 0016
title: What sync is, and what the first one does
parent: map
type: grilling
status: open
assignee: ~
blocked_by: []
---

## Question

Sync is explicit and on demand. Pin down what that means at every entry point.

- **Launch.** Does opening the tool read the store and show the last synced state
  without touching the network, or does it sync? The settled framing says sync is
  not an incidental side effect of opening the tool, which implies reading the
  store — confirm, and say what the header shows so "this is 40 minutes old" is
  never mistaken for "this is now".
- **First run, empty store.** There is no previous state, so there is no diff.
  Whether the first sync reports everything as new (loud and useless) or nothing
  as new (quiet and correct), and how the tool says which happened.
- **The key.** `r` currently means refresh. Whether sync keeps that key, and
  whether anything remains that merely re-reads the store.
- **During a sync.** The scan is ~0.8s but can fail. Whether the previous state
  stays on screen, and whether a failed sync leaves the store untouched — it must,
  or a failure destroys the baseline.
- **Partial sync.** The union of two queries is the whole result set; if one query
  fails the result is incomplete. A partial result must never be committed as a
  sync baseline, because every subsequent diff would inherit the hole. Confirm
  that, and say what the tool does instead.
- **Whether an automatic sync exists at all** — on a timer, or on launch after
  some age. The settled framing says no; make it explicit so it is not
  reintroduced as a convenience later.
- **Is a sync ever implicit?** Adding a repo to the config changes the result set.
  Whether that forces a sync, invalidates the baseline, or is simply reflected at
  the next explicit sync.

This ticket absorbs the launch-behaviour and staleness-display questions
originally posed in [0009](./0009-refresh-and-caching.md); that ticket now covers
only failure handling and retry.
