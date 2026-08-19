---
id: 0019
title: How GitLab is queried for the merge requests that concern me
parent: map
type: research
status: closed
assignee: Main
blocked_by: []
---

## Question

GitHub's scan is two `search` queries — `review-requested:@me` and
`involves:@me` — unioned, scoped by `repo:` qualifiers, at cost 1 each. What is
the GitLab equivalent, and what does it cost?

Established before this ticket was cut, and not to be re-derived:

- `glab` 1.110.0 is authenticated as **ermandduro**, user id 830730.
- `/merge_requests?scope=all&state=opened` returns **every publicly visible MR on
  gitlab.com** — 100 on the first page, from `gitlab-org/gitlab`,
  `freepascal.org/lazarus`, `redhat/centos-stream` and dozens more. It is not
  "MRs involving me" and is useless for this purpose. That semantic gap is the
  crux of the port.
- The driver has 8 open MRs, all authored by them, across
  `albanian-technology-distribution/kesh/kesh-back` and `kesh-front`, both at
  **path depth 3**.

To establish:

- Which parameters express the two halves of the scan. `reviewer_id` /
  `reviewer_username`, `assignee_id`, `author_id`, `scope=assigned_to_me` /
  `created_by_me`, and any approver filter. Whether anything covers GitHub's
  `involves:` — author OR assignee OR **mentions** OR **commenter**. If mentions
  and commenter are unreachable, that is a capability gap to record, not a detail
  to paper over.
- Global `GET /merge_requests` with filters versus per-project
  `GET /projects/:id/merge_requests`, and which can scope to a list of projects
  in one request.
- How a nested project is addressed — URL-encoded full path versus numeric id —
  and which identifier is stable enough to key state on.
- Whether GitLab's GraphQL endpoint can fetch across several projects in one
  query with the fields the model needs, and whether it beats N REST calls.
- The full field list on a real open MR, with the human-facing number (`iid`
  versus `id`) settled.
- Paging, wall-clock cost, and the advertised rate limits.

Findings: [0019-gitlab-mr-api.md](../research/0019-gitlab-mr-api.md)

## Resolution

Findings: [0019-gitlab-mr-api.md](../research/0019-gitlab-mr-api.md) — 648 lines,
29 claims each verified by a live command.

**One GraphQL query does it.** `projects(fullPaths: [...]) { nodes {
mergeRequests(...) } }` is the only call in either API that scopes to an
arbitrary list of projects in one request, and its complexity is independent of
how many paths are passed — 50 projects cost the same as 2. Measured **0.82–0.96s,
1 request** for all 8 open MRs across both kesh projects including pipeline,
approvals and reviewers, against **11.63s and 18 requests** for the REST
equivalent at equal fidelity. REST is O(2 + 2N) and cannot be improved: neither
`head_pipeline` nor approvals appears on any list endpoint.

**`involves:@me` has no GitLab equivalent, and this is a closed question.**
GitLab serves author and assignee; **mentions and commenter are unreachable as
filters** on any endpoint in either API. Established by exhausting every argument
on `Query`/`Project`/`Group.mergeRequests` and all four `CurrentUser.*MergeRequests`
connections — GraphQL rejects invented arguments outright, which is what makes it
closed rather than merely undiscovered. `reviewRequestedMergeRequests` *is* an
exact analogue of `review-requested:@me`. `assigneeOrReviewerMergeRequests` is a
real server-side OR, but of assignee and reviewer only —
`UnionedMergeRequestFilterInput` has no `authorUsernames`, so it cannot express
"author OR assignee". `/todos` is not a substitute (5 pending, all
`unmergeable`/`build_failed`, zero `mentioned`).

The gap is closable client-side only because the tracked set is small:
`commenters` and `participants` exist as *fields* though not as filters. **The
GitLab scan therefore inverts GitHub's**: fetch, then filter.

**Three traps that fail silently.** REST `/merge_requests?scope=all` ignores
`project_id` and `projects[]` — HTTP 200 with 100 strangers' MRs, looking like it
worked. REST ignores unknown query parameters generally (`commenter_username`,
`mentions`, `participant_id`, `totally_bogus=1` all returned the unfiltered
baseline), so **no REST filter may be trusted from a 200 alone**. And in GraphQL,
`or:{onlyReviewerUsername}` and `or:{reviewerWildcard}` are silently ignored while
`or:{assigneeUsernames}` works.

**Depth-3 nesting is a non-issue.** URL-encoded path and numeric id are
interchangeable everywhere; `path_with_namespace`/`fullPath` are stable.
kesh-back = 32073208, kesh-front = 32344706. But `REPO_PATTERN` in `src/query.ts`
permits exactly one slash and rejects every kesh path — see
[0022](./0022-declaring-a-provider.md).

**Limits.** GraphQL complexity ceiling 250 (a rich selection passes at `first: 50`,
fails at 60 with "complexity of 252"); REST `per_page` clamped to 100; rate limit
2000/min shared across REST and GraphQL — a non-issue at one request per scan.

Corrected in passing: `glab` is **1.114.0**, not the 1.110.0 recorded in the map's
Notes. `glab api graphql` cannot send list variables and hijacks any document
containing `__type`/`__schema` — confirmed independently while checking the stack
field.
