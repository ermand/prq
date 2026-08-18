---
id: 0009
title: Failure handling and retry on a sync
parent: map
type: grilling
status: open
assignee: ~
blocked_by: [0013]
---

## Question

**Narrowed 2026-08-07.** This ticket was written when the plan was a 15-minute
JSON cache. The destination has since widened: state lives in SQLite, sync is an
explicit act, and the diff between syncs is the point. Most of what this ticket
asked now belongs elsewhere and must not be answered twice:

- Persistence, form, retention, migration → *What the store holds, and for how long*
- Launch behaviour, staleness display, first run, partial sync → *What sync is, and what the first one does*
- The 15-minute TTL → superseded; sync is on demand, so there is no TTL to expire.

What remains here is only how a failing sync behaves:

- Whether an HTML 502 from an over-budget query is retried automatically, with
  what backoff, and how many attempts. Two queries at cost 1 each make a retry
  nearly free, which argues for retrying rather than degrading.
- Whether a retry is even likely to succeed, given the failure is a server-side
  execution budget rather than a transient network fault.
- What the driver sees while a retry is in flight, and what they see when it is
  exhausted.
- Whether a failure is recorded in the store at all — a log of failed syncs would
  explain a suspiciously old baseline, but it is state nobody has asked for.
- Whether a sync can be cancelled mid-flight, and what that leaves behind.

The load-bearing constraint, settled in *What sync is, and what the first one
does*: **a failed or partial sync must never be committed as a baseline**, or
every later diff inherits the hole.
