---
id: 0009
title: Refresh, caching, and staleness
parent: map
type: grilling
status: open
assignee: ~
blocked_by: [0001]
---

## Question

When does the tool fetch, what does it keep, and how does it tell you what you
are looking at is old?

Driven by the scan cost measured in *What PR data gh can return, and what a scan
costs*. Resolve:

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
