---
id: 0010
title: The provider seam GitLab would implement
parent: map
type: grilling
status: closed
assignee: Main
blocked_by: [0019, 0020]
---

## Question

What is the interface between the GitHub-specific code and everything else?

**Reframed 2026-08-19.** This ticket was written when GitLab was out of scope and
the seam was insurance against a hypothetical. GitLab is now in the destination,
with a real implementation to follow, so the seam has an actual second caller and
the honest-answer escape hatch below no longer applies: it must be designed
against two providers, not one plus a guess.

What it must settle:

- The operations the seam exposes. Plausibly one: given a list of projects,
  return the open PRs and MRs in the shared domain model. Resist adding more
  without a caller.
- **Whether a scan is one call per provider or one call overall**, and how the two
  results are unioned. GitHub is two `search` queries at cost 1; GitLab's shape is
  established by [0019](./0019-gitlab-mr-api.md) and is unlikely to match. Note
  the existing partial-scan invariant: a scan that could not see the whole set is
  never committed as a baseline. With two providers, a failure on one side must
  not silently invalidate the other — or must, if a partial union is unacceptable.
  That decision belongs here.
- Which model fields are universal and which are provider-specific. **Stacks are
  no longer the sharp case**: `MergeRequest.stack: [MergeRequest!]` exists on
  GitLab, verified by live introspection, so both providers have a first-class
  primitive. The sharp case is instead **`involves:`** — GitLab cannot express
  "mentions me" or "commented on it" as a *filter* in either API, so its scan must
  fetch and then filter client-side on `commenters` and `participants`, inverting
  GitHub's shape. Whether the seam exposes "give me what concerns the viewer" or
  "give me candidates plus a predicate" turns on this.
- How a capability a provider lacks is expressed: absent field, explicit
  "unsupported", or a capability declaration the UI consults. This now has teeth —
  [0021](./0021-gitlab-state-mapping.md) will report axes GitLab cannot fill.
- Where identity lives. Two providers means two viewers: **ermand** on GitHub,
  **ermandduro** on GitLab. `standing` is viewer-relative, so a row must be
  compared against the right one.
- **Where the seam sits relative to the store.** The store holds one flat table of
  PR rows keyed by the provider's node id. Whether provider is a column, whether
  ids can collide across providers, and whether a change diff may span providers.
- How authentication is obtained per provider — `gh auth token` today, `glab`
  having its own.

## Resolution

### One operation, one implementation per provider

```
scanProvider(projects) -> { rows: PullRequest[], failed: string[] }
```

Each provider owns how it gets there, because the two shapes do not converge:
GitHub issues two `search` queries and unions them server-side; GitLab issues one
`projects(fullPaths: [...]) { mergeRequests }` query and then filters
client-side, because `involves:@me` has no GitLab equivalent and provably cannot
have one ([0019](./0019-gitlab-mr-api.md)). The seam does **not** try to express a
common query language. It expresses a common *result*.

### A baseline per provider

The invariant that a partial scan is never committed is kept, but scoped to the
provider. Each provider's rows and diff commit independently.

The reason is measured, not aesthetic: the driver's GitLab token expired once
already, and an all-or-nothing rule would have frozen the tool's memory of **29
GitHub PRs** because of **8 GitLab MRs**. They are independent systems and the
store now says so.

Consequences to carry:

- A sync is per-provider. The store needs a provider dimension on `sync` and `pr`,
  and a change diff **never spans providers**.
- Node ids cannot collide — `gid://gitlab/MergeRequest/508789770` versus
  `PR_kwDOJL_VMc69ZXcv`, verified live — so the primary key needs no provider
  prefix. The column exists for scoping and display, not for uniqueness.
- The header shows one age. With two baselines it must show the **oldest**, or say
  both; showing the newest would let a stale half hide behind a fresh one. Exact
  wording belongs to [0016](./0016-sync-semantics-and-first-run.md).
- A provider that fails is reported as such and its previous rows stay on screen.
  Silently dropping them would read as "everything there was merged".

### The union model, with per-row precision

The shared model carries the richer shape and each row says how well it was
filled. It is not reduced to what both providers can express.

The reason: reducing to the intersection would degrade the GitHub board — 29 of
the driver's 37 rows — to match a provider supplying 8, and would specifically
weaken bucket 2, which was argued into existence on measured evidence (32 of 40
sampled PRs carried a stale block).

**Precision rides on the row, not on the provider.** This is the finding that
reshaped the ticket: capability is *per-project*. `changeRequesters` is `null` on
the driver's Free-tier projects and `[]` on Ultimate ones, within the same
provider and the same scan — so "can this row show a blocking review" varies
project by project. The signal already arrives in the scan payload, so probing
costs nothing and no separate capability request is needed (the settings endpoint
403s for non-Maintainers anyway).

Two fields change shape:

- **`staleBlock`** becomes `{ value: boolean; precision: "exact" | "approximate" } | null`.
  `null` means the provider cannot tell — 20% of GitLab's blocking cohort.
  `exact` is GitHub's sha comparison; `approximate` is GitLab's timestamp
  comparison. Bucket 2 must decide what to do with `null`, which is
  [0021](./0021-gitlab-state-mapping.md)'s call, but 0005's second amendment
  already set the precedent for GitHub's analogous null-commit case — resolve
  toward stale, because the alarming reading is the one that surfaces action.
- **`stack`** becomes `stacks: StackMembership[]` — plural. GitLab's `stack` is a
  path, not a partition: `gitaly!8812` sits in three stacks at once. GitHub fills
  zero or one entry and carries an identity; GitLab fills zero or more and carries
  none, and counts only open layers so it cannot report `5/6`. A single optional
  object would have meant two different things under one name.

### Identity per provider

`standing` is viewer-relative, so each provider carries its own viewer — **ermand**
on GitHub, **ermandduro** on GitLab — and a row is only ever compared against the
viewer of its own provider. Identity is discovered from the provider, never
configured: `viewer { login }` and `currentUser { username }` respectively.

### Authentication per provider

Each provider obtains its own credential and reports its own absence. `gh auth
token` today; GitLab has its own. A missing credential for one provider is a
failure of that provider, not of the scan — which falls out of per-provider
baselines for free.

### What this amends

- [0014](./0014-store-schema-and-retention.md) — the implemented schema has no
  provider dimension and assumes one baseline. Needs both.
- [0016](./0016-sync-semantics-and-first-run.md) — "what a sync is" is now
  per-provider, including what the header shows and what a first sync means when
  one provider has a baseline and the other does not.
- [0004](./0004-repo-list-storage.md) via
  [0022](./0022-declaring-a-provider.md) — a project entry must say which provider
  it belongs to before any of this can be wired.
- `CONTEXT.md` — gains **provider**, **precision** and the plural **stacks**.

### Deliberately not decided here

How an unfillable axis is *rendered*, and what bucket 2 does with a `null`
staleBlock. Both are [0021](./0021-gitlab-state-mapping.md). This ticket settles
only how the seam carries the difference.
