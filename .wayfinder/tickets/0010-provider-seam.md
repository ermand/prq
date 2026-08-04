---
id: 0010
title: The provider seam GitLab would implement
parent: map
type: grilling
status: open
assignee: ~
blocked_by: [0005]
---

## Question

What is the interface between the GitHub-specific code and everything else?

v1 ships GitHub only, but the seam is specified now so a GitLab implementation is
an addition rather than a rewrite. The risk is designing an abstraction against
one implementation and getting it wrong. Resolve:

- The operations the seam exposes. Plausibly one: given a list of repos, return
  the open PRs in the shared domain model. Resist adding more without a caller.
- Which model fields are universal and which are provider-specific. Stacks are
  the sharp case — GitHub has a first-class primitive, GitLab has nothing
  equivalent. Whether stack membership is optional on the shared model, or a
  provider-specific extension the renderer probes for.
- How a capability a provider lacks is expressed: absent field, explicit
  "unsupported", or a capability declaration the UI consults before rendering a
  column.
- Where identity lives — "me" differs per provider and per host.
- How much of this is worth building in v1 versus naming in the spec. An
  interface with one implementation and no second caller is often just a file
  boundary; say so if that is the honest answer.

Do not design GitLab's implementation — that is out of scope. Design only what
v1 must not preclude.
