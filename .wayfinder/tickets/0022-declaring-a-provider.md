---
id: 0022
title: How a saved entry declares which provider it belongs to
parent: map
type: grilling
status: open
assignee: ~
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
