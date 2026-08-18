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
