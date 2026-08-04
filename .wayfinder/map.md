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

_None yet — charting session only._

## Not yet specified

- **Degraded and error states.** Repo unreachable, token missing a scope, rate
  limit exhausted, partial scan failure. Can't be sharpened until the cost and
  failure modes of the scan are known and the layout exists to place them in.
- **First-run and empty states.** No repos saved yet; a saved repo with zero open
  PRs. Hangs on how the repo list is managed.
- **Distribution and install.** Homebrew, `go install`, npm, a single binary.
  Hangs on the tech stack choice.
- **Performance target.** What "fast enough" means for N repos, and whether N is
  5 or 50. Hangs on the measured cost of a scan.
- **Colour, theming, and terminal capability fallbacks.** Hangs on the layout.

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
