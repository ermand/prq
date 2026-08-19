---
id: 0022
title: How a saved entry declares which provider it belongs to
parent: map
type: grilling
status: closed
assignee: Main
blocked_by: [0010]
---

## Question

The config holds a flat list of `owner/name` strings. With two providers, how
does an entry say where it lives?

This is now blocking, not cosmetic. Measured: the driver's GitLab projects are
`albanian-technology-distribution/kesh/kesh-back` and `kesh-front` — **path depth
3** — and `isValidRepo` accepts exactly two segments, so the config rejects them
outright today. There is a test asserting that rejection: it was written to stop
search-qualifier injection into GitHub's `repo:` scope, and it happens to exclude
most real GitLab projects.

Resolve:

- **How provider is declared.** Inferred from path depth (fragile — plenty of
  GitLab projects sit at depth 2), an explicit per-entry field, separate lists per
  provider, or a host prefix such as `gitlab.com/group/sub/project`.
- **What replaces `isValidRepo`.** It currently guards a real injection sink: the
  entry is interpolated into a GitHub search string, and anything that is not
  `owner/name` can inject a qualifier and widen the scope. A looser pattern must
  not reopen that. Whether GitLab's identifier needs the same guarantee depends on
  how its query is built — see [0019](./0019-gitlab-mr-api.md).
- **Whether an entry is keyed by path or numeric id.** GitLab projects can be
  renamed and moved between groups; a path is readable, an id is stable. The store
  keys PR rows on the provider's node id, so the same question applies to whether
  a repo entry needs a stable identity at all.
- **What happens to an unreachable entry.** A GitLab project the token cannot see
  should not look like a project with no open MRs.
- **Whether the config stays one file.** Two providers means two identities — the
  GitHub viewer is `ermand`, the GitLab one is `ermandduro`. Whether that is
  configuration or discovered per provider.

Whatever lands here amends [0004](./0004-repo-list-storage.md), which recorded the
single-provider config as implemented.

## Resolution

### Two lists

```yaml
github:
  - nebulaltd/smip
  - nebulaltd/oddsy-backend

gitlab:
  - albanian-technology-distribution/kesh/kesh-back
  - albanian-technology-distribution/kesh/kesh-front
```

Provider is **structural**, never parsed and never inferred. Each list carries its
own validator, which the asymmetry below requires anyway.

**Depth inference was ruled out by evidence, not taste**: `gitlab-org/gitlab` and
`gitlab-org/cli` are both depth 2, structurally identical to a GitHub
`owner/repo`, while the driver's projects are depth 3. Depth carries no provider
information.

A host prefix (`gitlab.com/group/sub/project`) was the runner-up and is the only
shape that would extend to self-hosted GitLab or GHES — both out of scope. If that
changes, this is the decision to revisit; two lists become two lists of hosts
rather than a rewrite.

### Validation is per-provider, because the risk is

- **GitHub stays strict**: exactly `owner/name`, the existing `isValidRepo`. Its
  path is **string-interpolated** into a `repo:` search qualifier, so a looser
  pattern reopens the injection sink that guard was written to close. The existing
  test asserting `"o/a is:private"` is rejected keeps its meaning.
- **GitLab accepts two or more segments.** Its path goes in as a **bound GraphQL
  variable**, which by specification cannot alter query structure — verified that
  `fullPaths` accepts a variable of type `[String!]`. Validation there is about
  catching typos, not injection: reject empty segments, leading or trailing
  slashes, whitespace and control characters, and require at least one slash.

The shared `REPO_PATTERN` is therefore replaced by two, not loosened into one. A
single pattern permissive enough for GitLab would have silently widened GitHub's
search scope.

### Keyed by path in the config, by node id in the store

The config holds the human-readable path, because a human edits it. The store keys
rows on the provider's node id, which is already true and already collision-free.
A project renamed or moved between groups therefore loses its config entry — the
user fixes the path — but its **history survives**, because the rows were never
keyed on the path. No stable-identity field is needed in the config.

### An unreachable entry must not read as an empty one

This is the sharpest practical finding. `projects(fullPaths: [...])` **silently
omits** a path that does not exist or that the token cannot see: HTTP 200, no
error, just fewer nodes. Verified by requesting three paths, one of them a
deliberate typo, and receiving two with `errors: none`.

So a misspelled project is indistinguishable from a project with no open MRs
unless the client checks. The scan must **compare the requested paths against the
returned `fullPath` values and report every missing one as a provider failure** —
which, under the per-provider baseline rule from
[0010](./0010-provider-seam.md), means that provider does not commit until the
config is right. Matching is by value, not position: GitLab returns projects in
arbitrary order.

GitHub has no equivalent hole — an unknown `repo:` qualifier simply matches
nothing — so this check is GitLab-specific and belongs in its provider, not the
seam.

### One file, and `repos:` is retired loudly

The config stays a single file with two keys. Identity is not configured: each
provider discovers its own viewer, settled in 0010.

The old `repos:` key is **removed, not aliased**. Loading a config that still has
it fails with a message naming the replacement, rather than quietly assuming
GitHub. A silent alias would mean two spellings of the same thing forever, and the
one existing config is the driver's own — migrating it costs one edit.

Note this reverses the earlier tolerance for a stale `cacheTtlMinutes`, and
deliberately: an ignored key that no longer does anything is harmless, whereas
`repos:` would still *look* load-bearing.

Amends [0004](./0004-repo-list-storage.md).
