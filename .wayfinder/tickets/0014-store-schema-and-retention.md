---
id: 0014
title: What the store holds, and for how long
parent: map
type: grilling
status: open
assignee: ~
blocked_by: []
---

## Question

Sync is explicit and the diff is computed against the stored previous state. What
exactly is stored, keyed how, and what is thrown away?

`bun:sqlite` is settled. What is not:

- **Current state, or history?** The narrow reading needs only two generations —
  the state at the last sync and the state at the one before it — and a diff
  between them. The broad reading keeps every sync forever and makes the diff a
  query rather than a stored row. The narrow one is a fixed-size database; the
  broad one can answer questions nobody has asked yet.
- **What a row is.** One row per PR per sync, or one current row per PR plus a
  change log. The first is simple and grows linearly with syncs; the second needs
  care to stay consistent but stays small.
- **Identity.** The GraphQL node id is stable across repos and renames — confirm
  it is the primary key rather than `repo` plus `number`.
- **Whether the diff itself is persisted.** It is computed at sync time; storing
  it means the UI reads a result rather than recomputing, and means a diff can be
  shown for a sync whose predecessor has been pruned.
- **What happens on the second sync in a row.** Sync, do nothing, sync again: the
  first diff is replaced and its contents are lost. Is that acceptable, or does a
  sync that the driver has not acted on accumulate into the next diff?
- **Retention and growth.** How many syncs are kept, how big the file gets after
  a year, and whether pruning is automatic or a command.
- **Raw response or derived model.** Storing the raw GraphQL node survives a
  change to `PullRequest`; storing the derived model does not, and history means
  old rows were written by older code. The existing JSON cache already needed a
  version field for exactly this reason.
- **Schema migration policy.** How a schema version is recorded and what happens
  to a database written by an older build — migrate, or discard and resync.

Note what the store replaces: the 15-minute JSON cache. Say plainly whether a TTL
survives at all, given sync is now explicit.

## Implemented as a prototype — 2026-08-07

`/implement` was invoked before this ticket resolved, so `src/store.ts` now
embodies one answer. **The ticket stays open**: the code is a position to react
to, not the decision.

What it does today:

- **Current state plus an append-only change log**, not a row per PR per sync.
  Three tables: `sync` (one row per sync), `pr` (current state, replaced
  wholesale each sync), `change` (keyed `sync_id, pr_id, kind`).
- **The GraphQL node id is the primary key**, as suspected.
- **The derived model is stored**, serialised as JSON in `pr.payload` — not the
  raw API response. Queryable via `json_extract` if wanted; costs a schema
  version, which is `PRAGMA user_version`.
- **The diff is persisted**, so the UI reads a result rather than recomputing.
- **No retention or pruning at all.** The `change` table grows without bound.
  This is the sharpest thing left open here.
- **Migration**: freshness is detected by table presence, not by `user_version`,
  because the pragma defaults to 0 and so cannot distinguish a new file from a
  pre-versioning one. On a version mismatch the `pr` table is dropped and
  history is kept, forcing the next sync to reset the baseline.
- **A TTL no longer exists.** `cacheTtlMinutes` was removed from the config
  entirely; sync is explicit, so there is nothing to expire.

Still genuinely undecided: whether to keep more than one generation, retention
and pruning, whether the raw response should be stored alongside the derived
model, and what happens on a second sync in a row (today the previous diff is
simply replaced and lost).

## Amendment — 2026-08-19, from *The provider seam*

The implemented schema assumes **one** provider and **one** baseline. Both are now
wrong, and this ticket must resolve the shape rather than let the code drift.

- **`sync` and `pr` need a provider dimension.** Each provider commits its own
  baseline independently, so "the last sync" is per-provider and `lastSync()`
  returning a single row is no longer meaningful.
- **A change diff never spans providers.** `change.sync_id` already scopes to one
  sync; with per-provider syncs that becomes the enforcement point.
- **The primary key stays the provider's node id.** Ids cannot collide —
  `gid://gitlab/MergeRequest/508789770` versus `PR_kwDOJL_VMc69ZXcv`, verified
  live — so `provider` is a column for scoping and display, not for uniqueness.
- **`baselineReset` becomes per-provider.** Adding a GitLab project to a config
  that has only ever synced GitHub means one provider has a baseline and the other
  does not, in the same store, at the same time. Today's single boolean cannot say
  that.
- **`prCount` is the shortfall detector** and is compared against the rows read
  back. It must count per provider, or a provider that legitimately returned zero
  will read as a dropped baseline.
- **The stored payload changes shape** — `staleBlock` becomes an object or null,
  `stack` becomes plural `stacks`. That is a `SCHEMA_VERSION` bump, and the
  existing migration path (drop current state, keep history, reset the baseline) is
  exactly what it was built for.

Retention gains an angle it did not have: two providers means roughly twice the
change rows, and GitLab's lazily computed fields will generate churn until the
suppression rules from 0021 are in place.
