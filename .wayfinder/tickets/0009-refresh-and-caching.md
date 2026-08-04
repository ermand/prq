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

Now grounded in real numbers. A single aliased GraphQL query over 10 repos
returns in **7.9–10.3s**; the same work as sequential `gh pr list` shell-outs
takes **82s**, fully concurrent **11.35s**. Rate limit is a non-issue — a scan
costs 1–4 points against 5000/hr — so wall clock is the entire constraint, and
8-ish seconds is squarely in the range where a cache changes the felt
experience. Resolve:

- What happens on launch. Blocking scan behind a spinner, or render the last
  known state instantly and refresh underneath it.
- Whether anything is persisted between runs, and if so where and in what form.
  A cache is only worth it if the measured scan is slow enough to notice.
- Manual refresh: a key, and whether it refetches everything or just the
  selected repo.
- Whether there is any automatic refresh while the TUI is open, and at what
  interval. Weigh against rate-limit headroom.
- How staleness is communicated — a timestamp, a dimmed row, nothing.
- Behaviour when one repo in the list fails while the rest succeed. Whether a
  partial scan renders, and whether it is cached.
- Whether repos are scanned concurrently, and any cap on that concurrency.
- **What "fast enough" means, and what N is.** Graduated here from the map's fog
  now that the cost is measured. How many repos will actually be on the list —
  5 or 50 — and what launch-to-usable latency is acceptable. Note the measured
  numbers come from large public OSS repos; a handful of private repos with a
  few open PRs each will be far cheaper.
- Whether an HTML 502 from an over-budget query is retried automatically, with
  what backoff, and whether a retry is even likely to succeed.
