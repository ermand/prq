---
id: 0010
title: The provider seam GitLab would implement
parent: map
type: grilling
status: open
assignee: ~
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
