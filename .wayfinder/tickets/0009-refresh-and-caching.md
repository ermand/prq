---
id: 0009
title: Refresh, caching, and staleness
parent: map
type: grilling
status: open
assignee: ~
blocked_by: [0013]
---

## Question

When does the tool fetch, what does it keep, and how does it tell you what you
are looking at is old?

**Reframed after *How many open PRs a scan actually fetches, and how it pages*.**
A scan is now two parallel `search` queries at cost 1 each, **0.5–0.8s total** —
not the 8–10s aliased-repository scan this ticket was written against, and not the
323s full pagination that was rejected. That collapses most of the question: at
sub-second, a cache is no longer about hiding latency.

The driver has already decided **a 15-minute cache**. What remains is what that
means concretely:

- **What the cache is actually for**, given the scan is sub-second. Sparing the
  API on repeated launches, surviving offline, or instant first paint. The answer
  determines whether it is even worth persisting.
- What happens on launch: scan and wait (sub-second, so plausibly just fine), or
  paint cached state and refresh underneath.
- Where the cache lives and in what form, and whether it holds raw API responses
  or the derived domain model. Note the model may change between versions while
  the raw response will not.
- What a 15-minute TTL does when it expires while the TUI is open — silent
  refetch, visible refresh, or nothing until asked.
- Manual refresh: which key, and whether it bypasses the TTL.
- How staleness is shown — a timestamp, a dimmed header, nothing.
- **Partial failure.** The union of two queries is the whole result set, so if one
  query fails the result is incomplete in a way the user cannot see. Whether a
  partial union is rendered at all, whether it is cached, and how it is labelled.
- Whether an HTML 502 is retried automatically and with what backoff. With two
  cheap queries a retry costs almost nothing, which argues for retrying rather
  than degrading.
- **What "fast enough" means, and what N is.** Graduated here from the map's fog.
  Largely answered by the scan design — cost no longer scales with repo count —
  but confirm how many repos the list will actually hold.

Obsolete, and deliberately dropped: per-repo scan concurrency and its cap. There
are no per-repo queries any more.
