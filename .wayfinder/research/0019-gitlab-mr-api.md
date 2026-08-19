# Fetching "the merge requests that concern me" from GitLab

Companion to ticket [0010 — the provider seam](../tickets/0010-provider-seam.md).
Scope: **fetch semantics and cost only** — which endpoint, which filters, what it
returns, what it costs. The mapping of GitLab fields onto verdict / standing /
readiness / lifecycle is [0020](0020-gitlab-review-model.md), owned separately.

Environment: `glab 1.114.0 (4d7c6cda7)` — **not 1.110.0 as briefed**
(`glab --version`, [LIVE]). Authenticated as `ermandduro`, id `830730`, via an
OAuth token in the OS keyring. GraphQL and direct `curl` require
`Authorization: Bearer <token>`; `PRIVATE-TOKEN` returns `Invalid token` for this
credential [LIVE].

## Summary

- **Use GraphQL `projects(fullPaths: [...]) { nodes { mergeRequests(...) } }`.** It
  is the only call in either API that scopes to an arbitrary list of projects in
  **one request**, and its query complexity does **not** grow with the number of
  paths. Measured **0.82–0.96 s, 1 request, 7589 bytes** for all 8 open MRs across
  both kesh projects *including* pipeline status, approvals and reviewers —
  against **11.63 s and 18 requests** for the REST equivalent at the same
  fidelity. ~13x faster, 18x fewer requests [LIVE].
- **There is no GitLab equivalent of `involves:@me`.** No endpoint and no GraphQL
  argument, anywhere, filters on **mentions** or **commenter**. Exhaustive
  argument scan over `Query.mergeRequests`, `Project.mergeRequests`,
  `Group.mergeRequests` and all four `CurrentUser.*MergeRequests` connections
  returns only `subscribed` and `myReactionEmoji` — neither is involvement. This
  is a **capability gap, not a detail**: GitHub's second scan query has no
  server-side counterpart.
- **The gap is closable client-side, and only because the tracked set is small.**
  `commenters { nodes { username } }` and `participants { nodes { username } }`
  exist as *fields* on `MergeRequest` even though they do not exist as *filters*.
  So the GitLab scan inverts GitHub's: fetch **every** open MR in the saved
  projects, then filter for "me" in the client. Viable here (8 MRs); it does not
  scale to a `golang/go`-sized project.
- **Never use unscoped endpoints.** REST `/merge_requests?scope=all` returns all of
  gitlab.com, and — the sharp part — **silently ignores `project_id` and
  `projects[]`**, returning 100 strangers' MRs while looking like it worked.
  GraphQL `Query.mergeRequests` with no filter returns
  `Request timed out. Please try a less complex query or a smaller set of records.`
  It has **no project or group argument at all** [LIVE].
- **REST silently ignores unknown query parameters; GraphQL rejects unknown
  arguments.** `commenter_username=`, `mentions=`, `participant_id=` and
  `totally_bogus=1` each returned the unfiltered baseline of 6 [LIVE]. Any
  REST-based filter must be positively verified against a known-different count,
  never assumed from a 200.
- **Address projects by URL-encoded `path_with_namespace`; key on it too.** Depth-3
  nesting is a non-issue — `albanian-technology-distribution%2Fkesh%2Fkesh-back`
  and numeric `32073208` are interchangeable on every endpoint tested.
  `path_with_namespace` (REST) / `fullPath` (GraphQL) is the stable display and
  join key, and is the direct analogue of GitHub's `nameWithOwner`.
- **`iid` is the human-facing number, `id` is a global surrogate.** MR 326 in
  kesh-back is `"iid": 326` / `"id": 508789770`, and `web_url` ends
  `/-/merge_requests/326`. **In GraphQL `iid` is a `String`, not an `Int`** —
  `"iid": "326"` — so the domain model's `number: number` needs a parse.
- **The REST list shape has no CI status.** `head_pipeline` and `pipeline` appear
  only on `GET /projects/:id/merge_requests/:iid`, and approvals need a third
  endpoint. That is what turns a 2-request REST scan into an 18-request one.
  GraphQL returns `headPipeline { status }` and `approvalsLeft` inline.
- **GraphQL complexity limit is 250, and it caps page size, not project count.**
  The full selection passes at `first: 50` and fails at `first: 60` with
  `Query has complexity of 252, which exceeds max complexity of 250` [LIVE].
- **GitLab does have MR stacks — but they are not a partition.**
  `MergeRequest.stack: [MergeRequest]` exists and resolves live, so ticket 0010's
  "GitLab has nothing equivalent" is wrong as stated. The real problem is
  different: `gitaly!8812` appears in three stacks at once and the relation is not
  symmetric, so it is a **per-MR ancestry path**, not an equivalence class.
  CONTEXT.md's "a PR is either in exactly one stack or in none" is **false on
  GitLab**, and merged layers are excluded so `5/6` has no equivalent
  — see [Findings § Stacks](#stacks-are-not-actually-absent).

## Findings

### 1. The query problem — what reaches "MRs that concern me"

#### REST filter matrix

All against `GET /merge_requests` (global), `state=opened&per_page=100`, via
`glab api --method GET "merge_requests?..."` [LIVE]. Ground truth: **8 open MRs,
all authored by the viewer, 0 assigned, 0 with review requested.**

| Parameter | n | Reads |
| --- | --- | --- |
| `scope=created_by_me` | **8** | author only |
| *(no `scope`)* | **8** | identical — see below |
| `scope=all&author_id=830730` | **8** | author |
| `scope=all&author_username=ermandduro` | **8** | author |
| `scope=assigned_to_me` | 0 | assignee |
| `scope=all&assignee_id=830730` | 0 | assignee |
| `scope=all&reviewer_id=830730` | 0 | reviewer |
| `scope=all&reviewer_username=ermandduro` | 0 | reviewer |
| `scope=all&approver_ids[]=830730` | 0 | eligible approver |
| `scope=all&approved_by_ids[]=830730` | 0 | has approved |
| `scope=all&approved_by_usernames[]=ermandduro` | 0 | has approved |
| `scope=all&my_reaction_emoji=Any` | 0 | reacted |
| `scope=all&reviewer_id=Any` | — | `{"message":{"error":"Request timed out"}}` |

Every zero is a true zero for this account, so each parameter is *accepted*; none
is *proven* to work on positive data. The 0-vs-0 ambiguity is real and is the main
limit of what this account can establish — see Open gaps.

**Default `scope` differs by endpoint, and the `Link` header proves it.** The
global endpoint's own pagination header echoes the applied default verbatim [LIVE,
`glab api --method GET -i "merge_requests?state=opened&per_page=2"`]:

```
Link: <https://gitlab.com/api/v4/merge_requests?non_archived=false&order_by=created_at&page=2&per_page=2&scope=created_by_me&sort=desc&state=opened&...>; rel="next"
```

...i.e. `scope=created_by_me`. The project endpoint defaults to `all`, confirmed
positively against a project the viewer has never touched [LIVE]:

```
projects/gitlab-org%2Fcli/merge_requests?state=opened&per_page=5
  -> 5 ['timofurrer','mikeeddington','mikeeddington','mikeeddington','mikeeddington']
projects/gitlab-org%2Fcli/merge_requests?state=opened&scope=created_by_me&per_page=5
  -> 0 []
```

#### GraphQL: four purpose-built connections on `CurrentUser`

Introspected and run live. These are GitLab's real answer to "MRs that concern
me", and they are role-shaped exactly like GitHub's qualifiers:

| Connection | Live count (`state:opened`, global) |
| --- | --- |
| `currentUser { authoredMergeRequests }` | **8** |
| `currentUser { reviewRequestedMergeRequests }` | 0 |
| `currentUser { assignedMergeRequests }` | 0 |
| `currentUser { assigneeOrReviewerMergeRequests }` | 0 |

`reviewRequestedMergeRequests` **is** the exact analogue of `review-requested:@me`.
`assigneeOrReviewerMergeRequests` is a genuine server-side OR — but of *assignee*
and *reviewer only*.

Each accepts `projectPath`, `projectId` and `groupId` — **all singular scalars**:

```
Argument 'projectPath' on Field 'authoredMergeRequests' has an invalid value (["a", "b"]).
Expected type 'String'.
```

So N projects x M roles needs N*M aliased selections in one document. That works —
four aliases in one request returned
`{"back_auth":{"count":6},"back_rev":{"count":0},"front_auth":{"count":2},"front_rev":{"count":0}}`
[LIVE] — but complexity is per-selection, so it scales badly against
`projects(fullPaths:)`, whose complexity is flat.

#### The union filter, and its trap

`UnionedMergeRequestFilterInput` is the only OR primitive in the API. Introspected
fields, verbatim:

```
reviewerWildcard       ReviewerWildcardId
onlyReviewerUsername   String
assigneeUsernames      [String!]
reviewStates           [MergeRequestReviewState!]
```

**No `authorUsernames`.** The union is assignee OR reviewer — it cannot even
reproduce `author OR assignee`, let alone `involves:`.

Worse, two of its four members are **silently ignored** on `Project.mergeRequests`
[LIVE, baseline = 6]:

| Filter | count | Honoured? |
| --- | --- | --- |
| *(none)* | 6 | baseline |
| `or:{assigneeUsernames:["nobody-xyz"]}` | 0 | **yes** |
| `assigneeUsername:"nobody-xyz"` | 0 | **yes** |
| `or:{onlyReviewerUsername:"nobody-xyz"}` | **6** | **no — ignored** |
| `or:{reviewerWildcard:ANY}` | **6** | **no — ignored** |

`reviewerWildcardId: ANY` as a *direct* argument returns 0 correctly, so the bug is
specific to routing a reviewer predicate through `or:`. Do not use it.

#### The gap, stated plainly

**GitHub's `involves:@me` is `author OR assignee OR mentions OR commenter`. GitLab
can serve the first two. It cannot serve mentions or commenter — at all, on any
endpoint, in either API.**

Exhaustive scan of every argument on `Query.mergeRequests` (45 args),
`Project.mergeRequests` (46), `Group.mergeRequests`, and all four
`CurrentUser.*MergeRequests` connections (46–48) for any name containing *mention*,
*comment*, *note*, *participant*, *involve*, *commenter* or *discussion* [LIVE,
over the introspection dump] yields exactly two candidates, and neither is
involvement:

- `subscribed` — an explicit opt-in, not participation.
  `subscribed: EXPLICITLY_SUBSCRIBED` returned **0** for kesh-back even though REST
  reports `"subscribed": true` on MR !326 (implicit author subscription does not
  register) [LIVE].
- `myReactionEmoji` — reactions, not comments.

GraphQL rejects invented arguments outright, which is how this was proven closed
rather than merely undiscovered:

```
Field 'mergeRequests' doesn't accept argument 'commenterUsername'
```

**The workaround, and why it is acceptable here.** The data exists as fields even
though it does not exist as filters. Verified populating on a busy public project
[LIVE, `gitlab-org/cli`]:

```
cli!3748 notes=10 commenters=['duo-recommend-reviewers-gitlab-org','mmishaev','GitLabDuo','timofurrer',...]
                  participants=['phikai','viktomas','hacks4oats','ahmed.hemdan',...]
cli!3709 notes=35 commenters=['sylviashen','uchandran','GitLabDuo',...]
```

So the GitLab scan is **fetch-then-filter**, the inverse of GitHub's
**filter-then-fetch**: pull every open MR in the saved projects with `commenters`
and `participants` selected, and resolve involvement client-side. This is only safe
because the result set is bounded by the saved project list. The honest statement
for the seam: **GitLab's scan breadth is "all open MRs in the tracked projects",
not "MRs that concern me"** — the narrowing happens in the client, and a large
tracked project will page.

`/todos` is **not** a substitute. It is a dismissible notification inbox, not a
durable involvement index. Live: 5 pending, all `target_type: MergeRequest`, with
`action_name` distribution `Counter({'unmergeable': 3, 'build_failed': 2})` — zero
`mentioned` or `directly_addressed` [LIVE, `GET /todos?state=pending`].

### 2. Global vs group vs per-project

[LIVE, `state=opened&per_page=100`; OK = exactly the 8 expected MRs]

| Endpoint | Result |
| --- | --- |
| `/merge_requests?scope=created_by_me` | OK 8 — but author-only, cannot be widened |
| `/merge_requests?scope=all&project_id=32073208` | **BAD — 100 unrelated MRs**, param ignored |
| `/merge_requests?scope=all&projects[]=32073208` | **BAD — 100 unrelated MRs**, param ignored |
| `/groups/albanian-technology-distribution%2Fkesh/merge_requests?scope=all` | OK 8, **one request** |
| `/groups/albanian-technology-distribution/merge_requests?scope=all` | OK 8 (top group, recurses) |
| `/projects/32073208/merge_requests?scope=all` | OK 6 (kesh-back) |
| `/projects/32344706/merge_requests?scope=all` | OK 2 (kesh-front) |

The ignored-parameter rows are the finding. `project_id` and `projects[]` return
HTTP 200 with a full page of `dz!2, portfolio!46, gitlab!250825, tiki!10982...` — a
plausible-looking payload that is entirely wrong.

**Which scopes to a list of projects in one request?**

- **REST: only if they share a group**, via `GET /groups/:id/merge_requests`. It
  scopes to a *subtree*, not an arbitrary list, and defaults to `non_archived=true`
  (visible in its `Link` header). Projects spanning unrelated groups need one
  request per group, and a subtree may contain projects the user has not saved.
- **GraphQL: yes, unconditionally** — `projects(fullPaths: [...])` takes an
  arbitrary list [LIVE]. This is the decisive advantage and the recommendation.

**Failure mode worth designing for:** an unreadable or misspelled path is
**silently dropped**, not an error [LIVE]:

```
{ projects(fullPaths:["albanian-technology-distribution/kesh/kesh-back","no/such/project-xyz"]){ nodes { fullPath } } }
-> {"data":{"projects":{"nodes":[{"fullPath":"albanian-technology-distribution/kesh/kesh-back"}]}}}
```

The client must diff requested paths against returned `fullPath` values and report
the missing ones, or a revoked-access project vanishes from the dashboard without
a word.

### 3. Project identity at depth 3

Both forms work on every endpoint tested; nesting depth is irrelevant [LIVE]:

```
projects/albanian-technology-distribution%2Fkesh%2Fkesh-back/merge_requests?state=opened&scope=all -> 6
projects/32073208/merge_requests?state=opened&scope=all                                           -> 6
```

`GET /projects/albanian-technology-distribution%2Fkesh%2Fkesh-back` [LIVE]:

```json
{
 "id": 32073208,
 "name": "KESH-back",
 "path": "kesh-back",
 "path_with_namespace": "albanian-technology-distribution/kesh/kesh-back",
 "name_with_namespace": "atd / KESH / KESH-back",
 "web_url": "https://gitlab.com/albanian-technology-distribution/kesh/kesh-back",
 "default_branch": "develop",
 "visibility": "private"
}
```

`GET /projects/albanian-technology-distribution%2Fkesh%2Fkesh-front`:

```json
{
 "id": 32344706,
 "name": "KESH-front",
 "path": "kesh-front",
 "path_with_namespace": "albanian-technology-distribution/kesh/kesh-front",
 "name_with_namespace": "atd / KESH / KESH-front",
 "web_url": "https://gitlab.com/albanian-technology-distribution/kesh/kesh-front",
 "default_branch": "develop",
 "visibility": "private"
}
```

**Numeric ids: kesh-back `32073208`, kesh-front `32344706`.**

Recommendation: **configure and key on `path_with_namespace`**, the direct analogue
of GitHub's `nameWithOwner` — it is what the user types, what the URL shows, and
what GraphQL wants (`fullPaths` takes paths, not ids). Encode with
`encodeURIComponent` for REST. Note the config validator in `src/query.ts`,
`REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/`, **rejects these paths** — it permits exactly
one slash, and every kesh path has two.

Three identity forms coexist and must not be confused:

- REST `"id": 32073208` — numeric.
- GraphQL `"id": "gid://gitlab/Project/32073208"` — global id wrapping the same number.
- `fullPath` / `path_with_namespace` — the stable display and join key.

`name_with_namespace` (`"atd / KESH / KESH-back"`) is **display names, not path
segments** — `atd` is not `albanian-technology-distribution`. It is not a key.

### 4. GraphQL — one query, many projects

**Yes, and it decisively beats N REST calls.** The working shape:

```graphql
{
  projects(fullPaths: ["albanian-technology-distribution/kesh/kesh-back",
                       "albanian-technology-distribution/kesh/kesh-front"]) {
    nodes {
      fullPath
      mergeRequests(state: opened, first: 50) {
        count
        pageInfo { hasNextPage endCursor }
        nodes {
          id iid title webUrl draft createdAt updatedAt diffHeadSha
          targetBranch sourceBranch state
          mergeStatusEnum detailedMergeStatus conflicts
          reference userNotesCount
          approved approvalsLeft approvalsRequired
          author { username }
          reviewers { nodes { username } }
          assignees { nodes { username } }
          approvedBy { nodes { username } }
          commenters { nodes { username } }
          participants { nodes { username } }
          changeRequesters { nodes { username } }
          headPipeline { status }
          stack { iid }
        }
      }
    }
  }
}
```

Returns all 8 MRs, `count` and `pageInfo.hasNextPage` per project, in one request
[LIVE].

**Complexity limit is 250**, enforced statically and reported in the error. With
the selection above, page size is the only lever [LIVE]:

| `first:` | Result |
| --- | --- |
| 20 | OK |
| 50 | OK |
| 60 | `Query has complexity of 252, which exceeds max complexity of 250` |
| 70 | `...complexity of 266...` |
| 80 | `...complexity of 282...` |
| 100 | `...complexity of 314...` |

Linear at approximately **1.55 complexity per unit of `first`** over that range, on
a fixed base of about 159 for this selection. Two consequences:

1. **Complexity is independent of the number of `fullPaths`.** It is computed from
   the query document, not the data — one path and two paths both pass at
   `first: 50` [LIVE]. **Scoping to 50 projects costs the same as 2.** This is what
   makes `projects(fullPaths:)` the right primitive and aliased per-project
   selections the wrong one.
2. **Page size trades against selection richness.** A leaner selection buys a
   larger page; the rich one caps at 50/project/request. Directly analogous to the
   ~100-node budget ticket 0013 measured on GitHub.

Both errors and the runaway query are advertised in-band:
`Request timed out. Please try a less complex query or a smaller set of records.`
for unfiltered `Query.mergeRequests` [LIVE]. GitLab exposes **no `rateLimit { cost }`
node** — there is no GitHub-style per-query cost readout, only the complexity
number in the error when you exceed it.

**`glab api graphql` cannot send list variables.** Repeated `-f paths=...` flags
overwrite rather than accumulate — `-f paths=A -f paths=B` sent only `B` and
returned one project [LIVE]. It also intercepts any document containing
`__type`/`__schema` and substitutes a full 7.8 MB introspection. Use an inline
array literal, or `curl` with a JSON body. A Bun implementation using `fetch` is
unaffected by both.

### 5. Fields available on an MR

`GET /projects/32073208/merge_requests?state=opened&per_page=1&order_by=updated_at`,
**51 keys**, verbatim, description elided [LIVE]:

```json
{
 "id": 508789770,
 "iid": 326,
 "project_id": 32073208,
 "title": "feat: company registration and annual renewal workflow",
 "description": "<3212 chars elided>",
 "state": "opened",
 "created_at": "2026-07-18T12:27:55.548Z",
 "updated_at": "2026-07-28T08:49:47.270Z",
 "merged_by": null,
 "merge_user": null,
 "merged_at": null,
 "closed_by": null,
 "closed_at": null,
 "target_branch": "develop",
 "source_branch": "feature/company-registration-renewal",
 "user_notes_count": 0,
 "upvotes": 0,
 "downvotes": 0,
 "author": {
  "id": 830730,
  "username": "ermandduro",
  "public_email": "",
  "name": "Ermand",
  "state": "active",
  "locked": false,
  "avatar_url": "https://gitlab.com/uploads/-/system/user/avatar/830730/avatar.png",
  "web_url": "https://gitlab.com/ermandduro"
 },
 "assignees": [],
 "assignee": null,
 "reviewers": [],
 "source_project_id": 32073208,
 "target_project_id": 32073208,
 "labels": [],
 "draft": false,
 "imported": false,
 "imported_from": "none",
 "work_in_progress": false,
 "milestone": null,
 "merge_when_pipeline_succeeds": false,
 "merge_status": "cannot_be_merged",
 "detailed_merge_status": "conflict",
 "merge_after": null,
 "sha": "eca4ffcf527b8f8b496f1002f3c605de8f770efc",
 "merge_commit_sha": null,
 "squash_commit_sha": null,
 "discussion_locked": null,
 "should_remove_source_branch": null,
 "force_remove_source_branch": true,
 "prepared_at": "2026-07-18T12:27:56.695Z",
 "reference": "!326",
 "references": {
  "short": "!326",
  "relative": "!326",
  "full": "albanian-technology-distribution/kesh/kesh-back!326"
 },
 "web_url": "https://gitlab.com/albanian-technology-distribution/kesh/kesh-back/-/merge_requests/326",
 "time_stats": {
  "time_estimate": 0,
  "total_time_spent": 0,
  "human_time_estimate": null,
  "human_total_time_spent": null
 },
 "squash": true,
 "squash_on_merge": true,
 "task_completion_status": { "count": 0, "completed_count": 0 },
 "has_conflicts": true,
 "blocking_discussions_resolved": true,
 "approvals_before_merge": null
}
```

`GET /projects/32073208/merge_requests/326` is a **strict superset** — the list
shape has no key the detail shape lacks. The **11 detail-only keys** [LIVE]:

```
changes_count  diff_refs  first_contribution  first_deployed_to_production_at
head_pipeline  latest_build_finished_at  latest_build_started_at  merge_error
pipeline  subscribed  user
```

Values of the load-bearing ones:

```json
"diff_refs": { "base_sha": "1bfc6981...", "head_sha": "eca4ffcf...", "start_sha": "1bfc6981..." },
"head_pipeline": { "id": 2711385422, "sha": "eca4ffcf...", "status": "success",
                   "detailed_status": { "label": "passed", "group": "success" } },
"merge_error": null,
"subscribed": true,
"user": { "can_merge": true }
```

**`head_pipeline` is the whole cost story.** CI status is absent from the list
shape — union of all keys across the 8 live MRs contains only
`approvals_before_merge, merge_commit_sha, merge_when_pipeline_succeeds, sha, squash_commit_sha`
for anything CI- or approval-adjacent [LIVE]. Approvals need a *third* endpoint,
`GET /projects/:id/merge_requests/:iid/approvals` (24 keys, including
`approvals_required`, `approvals_left`, `approved_by`, `user_has_approved`,
`user_can_approve`, `suggested_approvers`).

#### Domain model mapping

| `PullRequest` field | REST | GraphQL | Note |
| --- | --- | --- | --- |
| `title` | `title` | `title` | |
| `url` | `web_url` | `webUrl` | absolute https; `safeUrl` applies unchanged |
| `number` | `iid` (Int `326`) | `iid` (**String `"326"`**) | `id` is a surrogate; `iid` matches `web_url` |
| `id` | `id` (`508789770`) | `gid://gitlab/MergeRequest/...` | union key across queries |
| `repo` | `references.full` split, or project lookup | `project { fullPath }` | list shape carries only `project_id` |
| `author` | `author.username` | `author { username }` | never null in practice; GitLab has no `ghost` |
| `createdAt` | `created_at` | `createdAt` | ISO-8601 with ms |
| `updatedAt` | `updated_at` | `updatedAt` | |
| `draft` | `draft` | `draft` | `work_in_progress` is a legacy duplicate |
| `headOid` | `sha` | `diffHeadSha` | `diff_refs.head_sha` agrees (`eca4ffcf...`) |
| `baseRef` | `target_branch` | `targetBranch` | |
| `merge` | `merge_status` / `detailed_merge_status` / `has_conflicts` | `mergeStatusEnum` / `detailedMergeStatus` / `conflicts` | 3 sources; mapping belongs to 0020 |
| `checks` | `head_pipeline.status` — **detail call only** | `headPipeline { status }` — inline | |

**`changeRequesters` doubles as a free capability probe.** It distinguishes
`null` from `[]` along tier lines [LIVE, one query over both projects]:

```
kesh-back        n=6  null=6  empty=0  populated=0
gitlab-org/cli   n=10 null=0  empty=10 populated=0
```

`null` means *this project cannot express a change request at all*; `[]` means it
can and nobody has. So the UI can decide whether to render a "changes requested"
column from data it already fetched, without calling the approval-settings
endpoint (which is 403 for non-maintainers). Confirmed independently after
`GitLabReviewScout` raised it; the mapping of this onto standing is 0020's.

Enums introspected verbatim:

```
MergeStatus             = UNCHECKED CHECKING CAN_BE_MERGED CANNOT_BE_MERGED CANNOT_BE_MERGED_RECHECK
MergeRequestReviewState = UNREVIEWED REVIEWED REQUESTED_CHANGES APPROVED UNAPPROVED REVIEW_STARTED
ReviewerWildcardId      = NONE ANY
AssigneeWildcardId      = NONE ANY ME
DetailedMergeStatus     = UNCHECKED CHECKING MERGEABLE COMMITS_STATUS CI_MUST_PASS CI_STILL_RUNNING
                          DISCUSSIONS_NOT_RESOLVED DRAFT_STATUS NOT_OPEN NOT_APPROVED BLOCKED_STATUS
                          EXTERNAL_STATUS_CHECKS PREPARING JIRA_ASSOCIATION CONFLICT NEED_REBASE
                          APPROVALS_SYNCING LOCKED_PATHS LOCKED_LFS_FILES MERGE_TIME
                          SECURITY_POLICIES_VIOLATIONS TITLE_NOT_MATCHING REQUESTED_CHANGES
                          SECURITY_POLICY_PIPELINE_CHECK
```

REST returns these lowercased (`"merge_status": "cannot_be_merged"`,
`"detailed_merge_status": "conflict"`); GraphQL returns them uppercased
(`"mergeStatusEnum": "CANNOT_BE_MERGED"`, `"detailedMergeStatus": "CONFLICT"`).
Confirmed on the same MR [LIVE].

**REST and GraphQL disagree on `approved`.** For MR !326, both report
`approvals_required: 0` and `approvals_left: 0`, yet REST `/approvals` says
`"approved": true` while GraphQL says `"approved": false` [LIVE]. REST resolves
"0 required" vacuously true, GraphQL as "nobody approved". Since verdict must
distinguish `approved` from `review-optional`, GraphQL's reading is the useful one
— but this must be chosen deliberately, not inherited. Flagged to 0020.

The full `MergeRequest` GraphQL type has **129 fields** [LIVE, introspection].

#### Stacks are not actually absent

Ticket 0010 assumes "GitHub has a first-class primitive, GitLab has nothing
equivalent." **That is wrong as stated.** `MergeRequest.stack` exists, typed
`[MergeRequest]`, described verbatim:

> Other open merge requests in the same stack as this merge request, ordered from
> the top of the stack to the bottom. Returns null if this merge request is not
> part of a stack, or if the stack contains more than 20 merge requests.

It resolves live on the kesh MRs, returning `"stack": []` (none are stacked)
[LIVE]. The shape differs from GitHub's — a sibling list rather than
`stack { number size }` plus `stackEntry { position }`. The capability is present,
and the seam should not be designed around "GitLab has no stacks".

Exercised on a project that actually stacks [LIVE,
`project(fullPath:"gitlab-org/cli"){ mergeRequests(state:opened, first:60){ nodes { iid state stack{iid state} } } }`
— 56 open MRs sampled, 24 with a non-empty stack]:

- **`stack` includes the querying MR itself**, despite the description saying
  "Other" — **24 of 24** non-empty stacks contain the MR that was queried. This is
  what makes position derivable: `indexOf(self) + 1`. Live: `cli!3744` reports
  `['3744','3745','3746','3741','3742','3743']` → **1/6**, `cli!3745` → **2/6**,
  `cli!3746` → **3/6**, `cli!3743` → **6/6**. The order is not monotonic by `iid`,
  consistent with it being a real dependency order rather than a sort.
- **Unstacked returns `[]`, not `null`** — 0 nulls in 56 sampled, so the
  documented null is at most the >20 truncation case, which stays unverified.
- **Every member observed was `state: opened`.** Merged layers are excluded, so
  CONTEXT.md's "both count already-merged layers, so a partly-landed stack still
  reports `5/6`" has **no GitLab equivalent**. GitLab's size shrinks as layers land.
- **`stack` is not a partition, and the relation is not even symmetric.** This is
  the finding that breaks the model, not the shape mismatch. In `gitlab-org/gitaly`
  [LIVE, `mergeRequests(iids:["8812","9094","8918","8821"])`]:

```
gitaly!9094  sh-mvcc-publish-instrumentation    -> poc/scaling-git  stack=['8812','9094']
gitaly!8918  sh-mvcc-stats-reftables            -> poc/scaling-git  stack=['8812','8918']
gitaly!8821  adapt-gitaly-mr-8757-to-scaling-git-> poc/scaling-git  stack=['8812','8821']
gitaly!8812  poc/scaling-git                    -> master           stack=['8812','8821']
```

  `!8812` sits in **three different stacks at once**, and it does not reciprocate:
  `!9094` reports `[8812, 9094]` while `!8812` reports `[8812, 8821]`. So
  `A ∈ stack(B)` does **not** imply `B ∈ stack(A)`. It is a **per-MR ancestry path**
  — the chain from this MR down to trunk — not an equivalence class. CONTEXT.md's
  "A PR is either in exactly one stack or in none" is **false on GitLab**, and a
  global stack graph cannot be reconstructed by unioning per-MR stacks. Any shared
  model field must therefore be per-MR (`position`, `depth`), never a stack
  identity.

The >20 truncation remains a real edge the seam should name. Verification of the
non-partition and self-inclusion findings was prompted by `GitLabReviewScout`
(ticket 0020) and re-run independently here.

### 6. Paging and cost

**Measured, both projects, all 8 open MRs, equal fidelity** (identity, timestamps,
draft, head sha, target branch, merge status, CI status, approvals, reviewers)
[LIVE]:

| Strategy | Wall clock | Requests | Bytes |
| --- | --- | --- | --- |
| **GraphQL, `projects(fullPaths:)`, `first: 50`** | **0.82 / 0.86 / 0.96 s** | **1** | **7589** |
| REST, 2 list + 8 detail + 8 approvals | **11.63 s** | **18** | — |
| REST, 2 list only (no CI, no approvals) | 0.93 / 0.93 / 1.76 s | 2 | — |
| REST, 1 group call (no CI, no approvals) | 0.70 / 0.75 / 2.45 s | 1 | 21644 |

**About 13x faster and 18x fewer requests at equal fidelity.** Even against the
*degraded* REST list — no CI status at all — GraphQL is no slower and returns **one
third the bytes** (7589 vs 21644) for strictly more data, because REST inlines a
full `author` object per MR while GraphQL selects `username`.

The REST scan is **O(2 + 2N)** in requests and cannot be improved: neither
`head_pipeline` nor approvals is available on any list endpoint.

**Paging.**

- REST: offset paging with `X-Total`, `X-Total-Pages`, `X-Per-Page`, `X-Page`,
  `X-Next-Page`, `X-Prev-Page` plus RFC 5988 `Link`. Live at `per_page=2`:
  `X-Total: 6`, `X-Total-Pages: 3`, `X-Next-Page: 2`. **`per_page` is clamped to
  100** — requesting 200 returns `x-per-page: 100` with no error [LIVE].
- GraphQL: cursor paging, `pageInfo { hasNextPage endCursor }` per project, plus a
  `count` — so truncation is always detectable per project. Both returned
  `hasNext=[False, False]` [LIVE]. Practical page ceiling **50** at this selection
  richness (section 4).

**Rate limits**, from response headers on both APIs [LIVE]:

```
ratelimit-limit: 2000
ratelimit-name: throttle_authenticated_api
ratelimit-observed: 6
ratelimit-remaining: 1994
ratelimit-reset: 1787137560
```

**2000 requests per minute** for authenticated API on gitlab.com, and **REST and
GraphQL share the same bucket** — identical `ratelimit-name`, and the counter
incremented across both. GitLab publishes no GraphQL point/cost budget analogous
to GitHub's 5000 points/hour; the binding constraint is the per-query complexity
limit of 250, not a cumulative budget. GraphQL responses also carry `x-request-id`
(e.g. `a2d8af77fb65076f-SOF`), useful for support escalation.

At 1 request per scan and a 15-minute cache (ticket 0013's direction), rate
limiting is a non-issue by roughly three orders of magnitude.

## Open gaps

- **Every reviewer-side filter is unproven on positive data.** `reviewer_id`,
  `reviewer_username`, `approver_ids[]`, `approved_by_*`,
  `reviewRequestedMergeRequests`, `assigneeOrReviewerMergeRequests` and
  `reviewStates` all returned 0 — consistent with the established ground truth
  (0 reviews requested, 0 assigned), but a correct filter and a silently broken one
  are indistinguishable at 0. Given that `or:{onlyReviewerUsername}` and
  `or:{reviewerWildcard}` **are** demonstrably ignored, this is not paranoia.
  Closing it needs an account with a real review request, or a second identity on a
  scratch project — neither reachable read-only from this account.
- **Whether `GET /merge_requests?scope=all` honours *any* project-narrowing
  parameter.** `project_id` and `projects[]` are ignored; no other candidate name
  was found. Not exhaustive over undocumented parameters, but since REST ignores
  unknown parameters silently, brute-forcing names cannot prove absence.
- **Complexity cost of individual fields** was not isolated. The 1.55/unit slope
  and ~159 base are fitted from the four failing `first:` values on one selection;
  a per-field table would let the client pick the page size analytically instead of
  by trial.
- **Behaviour above 100 projects.** `projects(fullPaths:)` is itself a connection
  defaulting to `first: 100`; a saved list longer than that needs cursor paging at
  the outer level. Untested — the driver has 2 projects.
- **Group-endpoint `non_archived=true` default** was read from the `Link` header,
  not tested against an actually archived project.
- **Stack: only the >20 truncation is now unverified.** Self-inclusion, ordering,
  `[]`-not-`null`, opened-only membership and the non-partition property were all
  exercised on `gitlab-org/cli` and `gitlab-org/gitaly`. No sampled stack exceeded
  20 members, so the documented `null` return was never observed and the truncation
  threshold is taken on the schema's word.
- **`approved` REST/GraphQL disagreement** is reported, not resolved — it belongs
  to the verdict mapping in 0020.
- **Self-hosted GitLab** was not tested. Complexity limit, rate limit and the
  presence of `stack` are all version- and tier-dependent; every number here is
  gitlab.com SaaS as of 2026-08-19.
