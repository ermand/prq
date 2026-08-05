---
label: wayfinder:map
title: Build-ready spec for a read-only PR review TUI
---

# Build-ready spec for a read-only PR review TUI

## Destination

A `SPEC.md` complete enough to hand to an implementation agent with no open
questions: a terminal UI that scans an explicitly saved list of GitHub repos and
presents every open PR — grouped by relevance to me, showing review state, CI
status, mergeable state, draft, age, and stack membership — each with a link I
can open in the browser. GitHub-only in v1, behind a provider seam GitLab could
later implement.

## Notes

- **Domain**: developer tooling / terminal UI over the GitHub API via `gh`.
- **Planning only.** This map produces decisions, not code. The one exception is
  throwaway prototypes made to react to, which are linked as assets, never
  shipped.
- **Skills every session should consult**: `/grilling` and `/domain-modeling` by
  default; `/research` for the research tickets; `/prototype` for the prototype
  tickets.
- **Environment facts already established** (do not re-litigate):
  - `gh` 2.96.0, authenticated as **ermand**; token scopes include `repo`,
    `read:org`.
  - `glab` 1.110.0, authenticated as **ermandduro** — reachable, but GitLab is
    out of scope for v1.
  - Available runtimes: Bun 1.3.14, Node 24.15.0, Go, Cargo 1.84.1, Python 3.14.6.
  - GitHub **Pull Request Stacks** entered public preview 2026-07-30 with REST
    endpoints for listing/getting stacks and a `stack` object on the PR resource;
    GraphQL exposes read-only stack fields. Exact shape is a research ticket.
- **Settled while charting**: read-only (no writes to GitHub); dashboard of all
  open PRs with relevance grouping as the default view; explicit saved repo list,
  no auto-discovery.

## Decisions so far

<!-- one line per closed ticket: enough to judge relevance, then open the link -->

- [What PR data gh can return, and what a scan costs](./tickets/0001-gh-pr-data-and-scan-cost.md)
  — fetch via one hand-written aliased GraphQL query, not N `gh pr list`
  shell-outs (7.9–10.3s vs 82s sequential); `gh pr list --json` has 47 fields and
  no stack field; review state is derivable from a list query but stale reviews
  need `reviews[].commit.oid`; the real limit is a ~10s server-side execution
  budget that returns an HTML 502, not the rate limit.
- [The shape of the GitHub Pull Request Stacks API](./tickets/0002-stacks-api-shape.md)
  — stacks are readable now with no preview header or opt-in; membership rides on
  the PR list response as `stack { id, number, base, size, position }`, key
  omitted when absent; `stack`/`stackEntry` verified live inside a
  `pullRequests` connection; automatic retargeting is invisible to the API; only
  2 of 30 open `cli/cli` PRs were stacked, so the treatment must degrade to
  nothing.
- [Viable TUI stacks for a 2026 terminal app](./tickets/0003-tui-stack-landscape.md)
  — five candidates measured; Ratatui cannot emit OSC 8 hyperlinks and is close
  to disqualified; only Textual has first-class Tree/Collapsible; time to first
  frame spans 3.4ms (Ratatui) to 321ms (OpenTUI compiled), binaries 743KB to
  70MB; `gh-dash` is the existing analogue. No winner picked.
- [The PR review-state taxonomy](./tickets/0005-review-state-taxonomy.md)
  — four independent axes, not one status: **verdict** (`reviewDecision`, the
  badge), **standing** (viewer-relative), **readiness** (merge + checks) and
  **lifecycle** (draft). Standing turns out to be server-side via
  `viewerDidAuthor`/`viewerLatestReview`/`viewerLatestReviewRequest`, overturning
  0001; "someone reviewed" means `latestOpinionatedReviews`, which excludes bot
  comment-only reviews; `reviewDecision: null` is a real fourth verdict distinct
  from `REVIEW_REQUIRED`; identity comes from `viewer { login }`. Whole taxonomy
  is one query at cost 1. Vocabulary in [CONTEXT.md](../CONTEXT.md).
- [How many open PRs a scan actually fetches, and how it pages](./tickets/0013-scan-breadth-and-paging.md)
  — a scan is **two `search` queries**, not a walk over the repo list: the saved
  repos become `repo:` scope qualifiers. `review-requested:@me` and
  `involves:@me`, unioned. Two are required because `involves:` excludes review
  requests — measured, it missed 27 of 32. Cost 1 each, 0.5–0.8s, parallel,
  versus 323s and cost 119 for full per-repo pagination. Truncation becomes moot:
  the filters define the set rather than clipping it.
- [Relevance buckets and sort order](./tickets/0007-relevance-buckets-and-sort.md)
  — **seven buckets, first match wins**: Awaiting me → I blocked it and it moved →
  Mine ready to land → Mine needs work → Mine waiting → I blocked it unchanged →
  Ambient. Per-bucket sort keys with a deterministic repo+number tiebreak; empty
  buckets render nothing; one view plus a grouping toggle and filter line; nothing
  hidden by default. Bucket 2 earns its place — 32 of 40 sampled changes-requested
  PRs carried a stale block. **Amends 0005**: my blocking review must be read from
  `latestOpinionatedReviews` filtered to the viewer, not `viewerLatestReview`,
  since a later comment masks a standing block. Also: `ReviewRequest` has no
  timestamp, and drafts can carry review requests.

## Not yet specified

- **Degraded and error states.** The failure surface shrank with the scan design —
  two cheap queries, either of which can return an HTML 502 that will not parse as
  JSON, or an HTTP 200 carrying partial `data` plus a per-field `errors[]` array.
  A partial union must read as incomplete rather than as whole. How the *TUI* says
  so still hangs on the layout existing to place it in.
- **First-run and empty states.** No repos saved yet; a saved repo with zero open
  PRs. Hangs on how the repo list is managed.
- **Distribution and install.** Homebrew, `go install`, npm, a single binary.
  Hangs on the tech stack choice. Measured binary sizes now span 743KB (Rust) to
  70MB (OpenTUI), so this is a real axis rather than a footnote.
- **Colour, theming, and terminal capability fallbacks.** Hangs on the layout.
- **Team-routed review requests.** `team-review-requested:<org>/<team>` is a valid
  qualifier but needs team slugs, which the repo list does not carry. Surfaced by
  the scan-strategy work; too coarse to ticket until it is known whether any of
  the driver's review requests actually arrive via a team.
- **Whether `gh-dash` already does this job.** A PR dashboard on Bubble Tea v2
  turned up during the TUI survey. Worth an honest look before specifying a
  competitor to it; too coarse to ticket until someone has actually run it.

## Out of scope

<!-- ruled beyond the destination; closed, never graduates -->

- **GitLab MR support and GitLab stack inference** — v1 is GitHub-only; the spec
  defines the provider seam but proves it against GitHub alone. A GitLab
  implementation is a fresh effort.
- **Any write to GitHub** — approve, comment, merge, re-request review. The TUI
  shows state; the browser link is the action.
- **Background daemon and desktop notifications** — v1 is a TUI you open.
- **GitHub Enterprise Server hosts and multiple accounts** — one authenticated
  `gh` account against github.com.
- **Review comment bodies** — review *state* is in; reading the discussion is the
  browser's job.
- **Repo auto-discovery** — from an org or from a local directory tree. The list
  is explicit and saved.
