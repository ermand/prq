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

## Implemented as a prototype — 2026-08-07

**The ticket stays open.** What the code does today:

- **Launch reads the store and touches no network.** The header shows the age of
  the last sync, or `never synced` when the store is empty, and the viewer reads
  `not synced` rather than a stale login.
- **First run shows nothing and says so** rather than syncing implicitly. Nothing
  is reported as new: the sync is marked `baselineReset` and the header reads
  `baseline set` instead of `0 changed`, because "0 changed" would claim nothing
  moved when the truth is nothing was comparable.
- **`S` syncs; lowercase `s` still focuses a stack.** Sync deliberately does not
  share a keystroke with a navigation action. `r` is gone — there is no longer
  anything that merely re-reads.
- **A second `S` while a sync is in flight cancels it**, and the notice says the
  baseline is unchanged.
- **A partial sync is shown but never committed.** `performSync` returns the
  fetched PRs with the failure list and skips `Store.commit` entirely, so the
  previous baseline survives. The header reads `INCOMPLETE — not committed`.
- **A failed sync leaves the displayed state alone** and reports the error in the
  footer.
- **No automatic sync exists anywhere** — no timer, no launch trigger, no
  age threshold.
- **`prq sync`** does the same headlessly and exits non-zero on a partial sync.

Still open: whether adding a repo to the config should force or invalidate
anything (today it is simply reflected at the next sync, and the stored
`sync.repos` records the scope each sync covered but is not yet compared), and
whether the empty-store first run should offer to sync rather than merely
instructing.

## Amendment — 2026-08-19, from *The provider seam*

A baseline is now **per provider**, which reopens several questions this ticket
recorded as settled for one:

- **What the header's single age means** when two baselines have different ages.
  The seam's resolution says show the **oldest**, or show both — never the newest,
  which would let a stale half hide behind a fresh one. Settle the wording here.
- **What a first sync is** when one provider has a baseline and the other does not.
  `baseline set` is currently a whole-store statement; it becomes per-provider, and
  a run that establishes GitLab's first baseline while diffing GitHub normally
  needs to say both things without reading as either.
- **What a partial sync means now.** Previously: one of two searches failed, so
  nothing is committed. Now a whole provider can fail while the other commits
  cleanly. `INCOMPLETE — not committed` is no longer accurate as a global label.
- **Whether `S` syncs everything or one provider.** Syncing all is the obvious
  default; whether a per-provider sync is worth a key is a real question given one
  provider may be persistently unreachable.
- **A failed provider keeps its previous rows on screen.** Dropping them would read
  as "everything there was merged" — the same fiction the partial-scan rule exists
  to prevent, in a new shape.
