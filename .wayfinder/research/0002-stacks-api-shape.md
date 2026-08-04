# 0002 — The shape of the GitHub Pull Request Stacks API

Research ticket 0002. All findings below were gathered on 2026-08-04.

**How to read this file.** Every claim is tagged either **[LIVE]** (observed in a real
API response, with the exact URL requested) or **[DOCS]** (quoted from
docs.github.com). Field names are copied verbatim from a real response body or
from a real schema reference page; none are paraphrased. Nothing was created,
modified, merged, commented on, or closed on GitHub — every request in this file
is a `GET`.

## Summary

- **Stacks are real, live, and readable today with zero ceremony.** `GET
  /repos/{owner}/{repo}/stacks` and `GET /repos/{owner}/{repo}/stacks/{stack_number}`
  both return `200` **unauthenticated**, with no preview `Accept` header, no
  `X-GitHub-Api-Version` pin, and no feature opt-in. Verified against repos the
  account does not own. **[LIVE]**
- **The single most important finding for the TUI: `stack` is present on the PR
  *list* response, not only on a single-PR `GET`.** One
  `GET /repos/{owner}/{repo}/pulls?state=open` returns every open PR *and* its
  stack membership, number, size and position. There is no N+1 and no second
  endpoint needed for the default dashboard view. **[LIVE]**
- The PR-level object is exactly `"stack": { "id", "number", "base": { "ref", "sha" },
  "size", "position" }`, and is **absent entirely** (key not emitted) on PRs that
  are not in a stack. Absence is the membership test. **[LIVE]**
- **`position` is 1-based from the base branch and counts merged PRs; `size` does
  not shrink as the stack lands.** In a partially merged stack of 6 (4 merged, 2
  open), the two open PRs reported `position: 5, size: 6` and `position: 6, size: 6`.
  A "5 of 6" label is directly renderable; "1 of 2 remaining" is not. **[LIVE]**
- **`gh pr list --json` at 2.96.0 exposes no stack field.** The full field dump has
  47 fields and none relate to stacks. `gh api` (or a raw HTTP client) is
  mandatory for stack data. **[LIVE]**
- **GraphQL can do it in one round trip.** `PullRequest.stack` and
  `PullRequest.stackEntry` are plain nullable fields on `PullRequest`, so they are
  selectable inside any `pullRequests` connection. This is established from the
  schema reference, **not** from a live query — see *Open gaps*. **[DOCS]**
- **Automatic retargeting is invisible in the stack payload and only shows up in
  `base.ref`.** A PR whose base was retargeted by GitHub reports its *new*
  `base.ref` with no marker, no event field, and an unchanged `stack.position`.
  Nothing in the API says "I was retargeted". **[LIVE]**
- `github/gh-stack` exists and is installed here (v0.0.4), but its only read
  command is `gh stack view`, which is scoped to the **local** checked-out stack.
  It cannot list or inspect arbitrary remote repos. It is not a substitute for
  calling the API. **[LIVE]**

## Findings

### 1. REST endpoints: paths, parameters, response shape, preview headers

**[DOCS]** From <https://docs.github.com/en/rest/pulls/stacks> ("REST API endpoints
for stacked pull requests"). The page carries this note:

> Most endpoints use `Authorization: Bearer <YOUR-TOKEN>` and `Accept: application/vnd.github+json` headers, plus `X-GitHub-Api-Version: 2026-03-10`.

That is the standard REST preamble, **not** a stacks-specific preview opt-in. The
`accept` parameter is documented only as:

> **`accept`** (string) — Setting to `application/vnd.github+json` is recommended.

"Recommended", not required. There is no `application/vnd.github.<name>-preview+json`
media type anywhere on the page, and no feature-flag parameter.

The two read endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/repos/{owner}/{repo}/stacks` | Lists pull request stacks in a repository |
| `GET` | `/repos/{owner}/{repo}/stacks/{stack_number}` | Gets a pull request stack by its stack number |

Query parameters on the list endpoint, quoted from the docs:

- **`pull_request`** (integer) — "Filter to the stack containing this repository pull request number."
- **`per_page`** (integer) — default `30`, max 100.
- **`page`** (integer) — default `1`.

Documented status codes: list is `200` / `404` / `422`; get-one is `200` / `404`.

The remaining endpoints on that page are all writes and are out of scope for a
read-only consumer, but are recorded here so nobody re-discovers them by
accident: `POST /repos/{owner}/{repo}/stacks` (create),
`POST /repos/{owner}/{repo}/stacks/{stack_number}/add`,
`POST /repos/{owner}/{repo}/stacks/{stack_number}/unstack`.

**[DOCS]** Documented `200` shape for the **list** endpoint — an array of
`Pull Request Stack Minimal`:

```
id            required, integer
number        required, integer
node_id       required, string
url           required, string, format: uri
base          required, object:
  ref         required, string
open          required, boolean
created_at    required, string, format: date-time
pull_requests required, array of objects:
  number      required, integer
  state       required, string, enum: open, closed
  draft       required, boolean
  merged_at   required, string or null, format: date-time
  head        required, object:
    ref       required, string
    sha       required, string
```

**[LIVE]** `GET https://api.github.com/repos/cli/cli/stacks` — returned `200` with
three stacks. First element verbatim (showing two of its six `pull_requests` for
length; the elided entries have identical key sets):

```json
{
  "id": 80058,
  "number": 14025,
  "node_id": "PRS_kwDODKw3uc4AATi6",
  "url": "https://api.github.com/repos/cli/cli/stacks/14025",
  "base": { "ref": "trunk" },
  "open": true,
  "created_at": "2026-07-31T11:40:59Z",
  "pull_requests": [
    {
      "number": 13988,
      "state": "closed",
      "draft": false,
      "merged_at": "2026-08-01T07:52:47Z",
      "head": {
        "ref": "williammartin-fix-restwithnext-error-type",
        "sha": "b46289cee641f18ec44f4b9b1c9fbbc8b3665976"
      }
    },
    {
      "number": 14059,
      "state": "open",
      "draft": false,
      "merged_at": null,
      "head": {
        "ref": "williammartin-route-extension-http",
        "sha": "420a538331addd0607e0f180edad18215714c9dc"
      }
    }
  ]
}
```

The live list response matches the documented `Pull Request Stack Minimal` schema
exactly — same eight top-level keys, same five keys per `pull_requests` entry.

**[LIVE]** The `pull_request` filter works as documented.
`GET https://api.github.com/repos/cli/cli/stacks?pull_request=14059` returned a
one-element array containing stack `14025`.
`GET https://api.github.com/repos/cli/cli/stacks?pull_request=14062` returned `[]`
— PR 14062's body literally says "**This is a stacked PR.** It targets #14059", yet
it is not a member of any *native* stack. **Prose in a PR body is not stack
membership.** Only the API answers that question.

**[LIVE] The get-one endpoint returns a materially richer `pull_requests[]` than
the list endpoint, and the docs do not say so.** The docs describe the get-one
`200` body only as "Same response schema as Create a pull request stack", whose
`pull_requests` is specified as the bare `required, array of object` — no member
fields at all. In reality,
`GET https://api.github.com/repos/cli/cli/stacks/13956` returned entries with
these keys:

```json
{
  "url": "https://api.github.com/repos/cli/cli/pulls/13946",
  "id": 4109745190,
  "number": 13946,
  "head": {
    "ref": "tidy-dev-pr-checkout-worktree",
    "sha": "980366b4a8cc8374fd6a6bf82903c5bd6e576806",
    "repo": { "id": 212613049, "url": "https://api.github.com/repos/cli/cli", "name": "cli" }
  },
  "base": {
    "ref": "trunk",
    "sha": "2c87c82fa2484f26c7181cbf31be406c943fdaaf",
    "repo": { "id": 212613049, "url": "https://api.github.com/repos/cli/cli", "name": "cli" }
  },
  "node_id": "PR_kwDODKw3uc709bwm",
  "title": "Add --worktree flag to gh pr checkout",
  "state": "closed",
  "merged_at": "2026-08-04T11:47:12Z",
  "draft": false,
  "html_url": "https://github.com/cli/cli/pull/13946",
  "user": { "login": "tidy-dev", "id": 75402236, "...": "full user object" }
}
```

So `title`, `html_url`, `user`, `base` and `node_id` are available from get-one but
**not** from list. Design consequence: if the TUI ever needs to render a whole
stack as a unit, get-one is one request instead of N PR fetches. `html_url` here is
also the clickable browser link required by the destination.

**[LIVE]** No preview header, no API-version header and no authentication were sent
on any of the requests above, and all returned `200`. Anonymous rate limit was in
force throughout: `GET https://api.github.com/rate_limit` reported
`"core": { "limit": 60 }`, which is the unauthenticated tier.

### 2. The `stack` object on the pull request resource

**[LIVE]** `GET https://api.github.com/repos/cli/cli/pulls/14059` (single PR).
Verbatim, in document order, sitting between `auto_merge` and `draft`:

```json
"stack": {
  "base": {
    "ref": "trunk",
    "sha": "a3ed50ad5fafddd0e15ab8838c2136c8d25572df"
  },
  "id": 80058,
  "number": 14025,
  "position": 6,
  "size": 6
}
```

Field-by-field, with types read off the live values:

| Field | Type | Meaning (as evidenced) |
| --- | --- | --- |
| `id` | integer | Internal stack id. Matches `id` on the stacks endpoint. |
| `number` | integer | Per-repo stack number. This is the `{stack_number}` path segment. |
| `base.ref` | string | The branch the *whole stack* targets — `"trunk"`, i.e. the trunk, **not** this PR's own base. |
| `base.sha` | string | Commit sha of that base. **Present here but absent from the stacks-endpoint `base`, which carries `ref` only.** |
| `size` | integer | Total PRs in the stack, merged ones included. |
| `position` | integer | This PR's 1-based slot, counting from the base branch. |

**Does it appear on list responses, or only on a single-PR `GET`? It appears on
both.** This was the decisive test, and it needed care: a naive check gives the
wrong answer.

- `GET https://api.github.com/repos/cli/cli/pulls?state=open&per_page=1` returned PR
  **14062**, whose object ends `... "author_association": "MEMBER", "auto_merge": null,
  "assignee": null, "active_lock_reason": null` — **no `stack` key**. Taken alone this
  looks like "list responses omit `stack`". It is not: PR 14062 simply is not in a
  native stack (confirmed in section 1 via `?pull_request=14062` returning `[]`).
- Re-running the list against a PR that *is* stacked settles it.
  `GET https://api.github.com/repos/cli/cli/pulls?state=open&head=cli:williammartin-route-extension-http`
  returned PR 14059, whose list element ends:

```json
"author_association": "MEMBER",
"auto_merge": null,
"stack": {
  "id": 80058,
  "number": 14025,
  "base": {
    "ref": "trunk",
    "sha": "a3ed50ad5fafddd0e15ab8838c2136c8d25572df"
  },
  "size": 6,
  "position": 6
},
"assignee": null,
"active_lock_reason": null
```

Same five members, same values as the single-PR `GET` (JSON key order differs
between the two representations; that is cosmetic). **Conclusion: the `stack` key is
emitted on both the list and the detail representation, and is omitted entirely —
not `null` — when the PR is not in a stack.** A consumer must treat a missing key
as "unstacked" rather than expecting `"stack": null`.

For the TUI this means the whole scan is `GET /repos/{o}/{r}/pulls?state=open`
per saved repo, and stack membership arrives for free in that same page.

### 3. GraphQL: types, fields, and whether one query returns every open PR *and* its stack position

**This section is [DOCS] only. Live GraphQL introspection was not possible from
this machine — see *Open gaps* for exactly what was attempted.**

**[DOCS]** From the GraphQL schema changelog,
<https://docs.github.com/en/graphql/overview/changelog>, under "**Schema changes for
2026-07-22**" — verbatim lines:

```
* Type 'PullRequestStack' was added
* PullRequestStack object implements Node interface
* Field baseRefName was added to object type PullRequestStack
* Field entries was added to object type PullRequestStack
* Argument after: String added to field PullRequestStack.entries
* Argument before: String added to field PullRequestStack.entries
* Argument first: Int added to field PullRequestStack.entries
* Argument last: Int added to field PullRequestStack.entries
* Field id was added to object type PullRequestStack
* Field number was added to object type PullRequestStack
* Field size was added to object type PullRequestStack
* Type 'PullRequestStackEntry' was added
* PullRequestStackEntry object implements Node interface
* Field id was added to object type PullRequestStackEntry
* Field position was added to object type PullRequestStackEntry
* Field pullRequest was added to object type PullRequestStackEntry
* Field stack was added to object type PullRequestStackEntry
* Type 'PullRequestStackEntryConnection' was added
* Field edges was added to object type PullRequestStackEntryConnection
* Field nodes was added to object type PullRequestStackEntryConnection
* Field pageInfo was added to object type PullRequestStackEntryConnection
* Field totalCount was added to object type PullRequestStackEntryConnection
* Type 'PullRequestStackEntryEdge' was added
* Field cursor was added to object type PullRequestStackEntryEdge
* Field node was added to object type PullRequestStackEntryEdge
...
* Field stack was added to object type PullRequest
* Field stackEntry was added to object type PullRequest
```

Note the date: the GraphQL types landed **2026-07-22**, eight days before the
2026-07-30 public-preview announcement.

**[DOCS]** Exact signatures with types, from the generated schema reference page
<https://docs.github.com/en/graphql/reference/pulls> (the "Pull requests" category
of the GraphQL reference). Quoted verbatim:

On `PullRequest`:

```
* `stack` (PullRequestStack): The stack this Pull Request belongs to, or null if it is not part of a stack.
* `stackEntry` (PullRequestStackEntry): The stack entry for this Pull Request, or null if it is not part of a stack.
```

```
## PullRequestStack - object

A stack of PullRequests.

**Implements:** Node

### Fields for `PullRequestStack`

* `baseRefName` (String!): The branch that the stack's pull requests target.
* `entries` (PullRequestStackEntryConnection!): The entries in the stack. _(Pagination: `after`, `before`, `first`, `last`)_
* `id` (ID!): The Node ID of the PullRequestStack object.
* `number` (Int!): A number uniquely identifying the stack within its repository.
* `size` (Int!): The total number of pull requests in the stack.

## PullRequestStackEntry - object

A member of a PullRequestStack.

**Implements:** Node

### Fields for `PullRequestStackEntry`

* `id` (ID!): The Node ID of the PullRequestStackEntry object.
* `position` (Int!): This entry's position in the stack, where 1 is the closest to the base branch, 2 is stacked on top of 1, etc.
* `pullRequest` (PullRequest): The pull request that occupies this position in the stack.
* `stack` (PullRequestStack): The stack that this entry is a part of.

## PullRequestStackEntryConnection - object

Entries in a pull request stack.

### Fields for `PullRequestStackEntryConnection`

* `edges` ([PullRequestStackEntryEdge]): A list of edges.
* `nodes` ([PullRequestStackEntry]): A list of nodes.
* `pageInfo` (PageInfo!): Information to aid in pagination.
* `totalCount` (Int!): Identifies the total count of items in the connection.

## PullRequestStackEntryEdge - object

An edge in a connection.

### Fields for `PullRequestStackEntryEdge`

* `cursor` (String!): A cursor for use in pagination.
* `node` (PullRequestStackEntry): The item at the end of the edge.
```

That `position` doc line independently confirms the 1-based-from-base ordering
that section 5 demonstrates live.

**Can stack fields be selected inside a `pullRequests` connection?** Yes.
`stack` and `stackEntry` are ordinary nullable fields declared on the
`PullRequest` object type. Nothing in the reference marks them with a `@preview`
directive, restricts them to a root-level lookup, or attaches arguments. Any
`PullRequest` node — including every node inside
`repository { pullRequests(states: OPEN) { nodes { ... } } }` — can select them.
So this is a legal single-round-trip query for "every open PR and its stack
position":

```graphql
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100) {
      nodes {
        number
        title
        url
        isDraft
        reviewDecision
        mergeable
        stack { number size baseRefName }
        stackEntry { position }
      }
    }
  }
}
```

**This query was written from the schema; it was never executed.** Treat it as
schema-derived and verify it once a working token is available. Note also that
`PullRequestStack` carries **no** equivalent of the REST `open` boolean and no
per-entry merge state — to learn whether a stack still has unmerged layers you
must walk `entries { nodes { pullRequest { state merged } } }`, which costs more
than the REST `open` flag.

### 4. Does `gh pr list --json` expose a stack field at 2.96.0?

**No. `gh api` (or a raw HTTP client) is mandatory.** **[LIVE]**

`gh --version` reports `gh version 2.96.0 (2026-07-02)`.

`gh pr list --json` with no value prints all valid fields. Complete output, all 47
fields, verbatim:

```
additions, assignees, author, autoMergeRequest, baseRefName, baseRefOid, body,
changedFiles, closed, closedAt, closingIssuesReferences, comments, commits,
createdAt, deletions, files, fullDatabaseId, headRefName, headRefOid,
headRepository, headRepositoryOwner, id, isCrossRepository, isDraft, labels,
latestReviews, maintainerCanModify, mergeCommit, mergeStateStatus, mergeable,
mergedAt, mergedBy, milestone, number, potentialMergeCommit, projectCards,
projectItems, reactionGroups, reviewDecision, reviewRequests, reviews, state,
statusCheckRollup, title, updatedAt, url
```

No `stack`, no `stackEntry`, no stack-adjacent field. `gh pr view --json` prints an
identical list. Since `gh pr list` builds a fixed GraphQL selection set internally,
there is no flag that coaxes stack data out of it.

**Consequence for the spec.** Every other field the destination asks for — review
state (`reviewDecision`, `latestReviews`), CI status (`statusCheckRollup`),
mergeable state (`mergeable`, `mergeStateStatus`), draft (`isDraft`), age
(`createdAt`, `updatedAt`), link (`url`) — is available from `gh pr list --json`.
Stack membership is the **only** required field that is not. The provider layer
therefore cannot be a thin `gh pr list` wrapper; it needs either `gh api` REST
(where section 2 shows stack data rides along on the PR list for free) or a
hand-written `gh api graphql` query (section 3).

### 5. Partially merged stacks, and PRs retargeted by automatic rebase

**Partially merged.** **[LIVE]** Stack `14025` in `cli/cli` is the ideal specimen:
six PRs, four merged, two open.

| PR | `state` | `merged_at` | |
| --- | --- | --- | --- |
| 13988 | `closed` | `2026-08-01T07:52:47Z` | merged |
| 13989 | `closed` | `2026-08-04T08:25:21Z` | merged |
| 13994 | `closed` | `2026-08-04T08:35:01Z` | merged |
| 13997 | `closed` | `2026-08-04T09:01:27Z` | merged |
| 14013 | `open` | `null` | open |
| 14059 | `open` | `null` | open |

Observations that matter:

- The stack reports `"open": true` while four of six members are already merged.
  **`open` means "the stack still has unmerged layers", not "no layer has landed".**
- Merged PRs **stay in `pull_requests[]` forever**. The array is the full history of
  the stack, not the remaining work.
- `size` stayed at `6` and positions stayed put:
  `GET /repos/cli/cli/pulls/14013` gave `"position": 5, "size": 6`;
  `GET /repos/cli/cli/pulls/14059` gave `"position": 6, "size": 6`.
  **Neither renumbers as lower layers land.** So "PR 5 of 6" is honest and stable,
  but a reader who wants "1 of 2 remaining" must compute it by counting members
  with `merged_at == null`.
- `state` and `merged_at` are independent. Stack `13956` contains PR 13946 with
  `"state": "closed", "merged_at": "2026-08-04T11:47:12Z"` (merged) alongside PRs
  13953 and 13955 with `"state": "closed", "merged_at": null` (**closed without
  merging**). That stack reports `"open": false`. A consumer must test `merged_at`,
  not `state`, to distinguish merged from abandoned.

**Retargeted by automatic rebase.** **[LIVE]** PR 14013 is the specimen. Its own body
says "**This is a stacked PR.** It targets #13997". PR 13997 merged at
`2026-08-04T09:01:27Z`. Fetching PR 14013 afterwards:

```json
"base": {
  "label": "cli:trunk",
  "ref": "trunk",
  "...": "repo and user objects"
}
```

Its base is now `trunk`, not 13997's head branch. **GitHub silently rewrote the
base when the layer below merged.** Meanwhile its stack object is unchanged in
shape and still reads `"position": 5, "size": 6`.

The load-bearing negative result: **the API reports the retarget nowhere except in
`base.ref` itself.** There is no `retargeted` flag, no `base_retargeted_at`
timestamp, no marker inside `stack`, and no change to `position` or `size`. A PR
retargeted by GitHub is indistinguishable from one a human retargeted, unless you
diff `base.ref` against a value you cached earlier or read the
`automatic_base_change_succeeded` timeline event (a separate request, and out of
scope for a read-only dashboard's hot path).

One more consequence worth carrying into the layout decision: for a stacked PR,
`base.ref` (this PR's immediate parent branch) and `stack.base.ref` (the trunk the
whole stack targets) are **different values** and both are meaningful. PR 14059 has
`"base": { "ref": "williammartin-migrate-repo-autolink" }` but
`"stack": { "base": { "ref": "trunk" } }`. Showing the wrong one will mislead.

### 6. Observability on repos you do not own, and the scope of the preview

**[LIVE] Stacks are observable on repos the account does not own, with no
authentication at all.** Every stack response quoted in this file came from an
**unauthenticated** request to a public repo owned by someone else:

- `GET https://api.github.com/repos/cli/cli/stacks` gave `200` and three stacks.
- `GET https://api.github.com/repos/github/gh-stack/stacks` gave `200` and multiple stacks.
- `GET https://api.github.com/repos/rust-lang/rust/stacks?per_page=1` gave `200` and `[]`.

The `rust-lang/rust` result is the informative one. A repo with no stacks returns
`200` and an **empty array**, not `404` and not `422`. The endpoint is *mounted* on
a repo that has plainly never used the feature.

**[LIVE] Therefore the preview is enabled globally, not per-repo and not per-org**,
at least for reads. Three unrelated owners — the org that builds the feature
(`github`), an unrelated org (`cli`), and a foundation repo (`rust-lang`) — all
serve the endpoint identically, to an anonymous caller, with no opt-in header.
This is consistent with the changelog's framing that the feature is "rolling out
to all repositories".

Practical read: **a scanner does not need to probe whether a repo "has stacks
enabled" before querying, and does not need to special-case `404`.** An empty
array is the normal answer for a repo that does not stack. Visibility follows
ordinary repo permissions — a private repo will need the `repo` scope the account
is supposed to hold, which was not exercised here (no valid token was available;
see *Open gaps*).

**Not established:** whether an org or repo admin can *disable* stack creation, and
whether such a setting would also hide the read endpoints. Nothing in the REST
reference exposes a stacks setting, but absence from that one page is weak
evidence and I will not dress it up as a finding.

### 7. The `gh-stack` CLI extension: does it offer a read command worth calling?

**It exists, it is first-party, and it is already installed here — but it has no
read command a repo-scanning TUI can use.** **[LIVE]**

Existence and provenance, from `GET https://api.github.com/repos/github/gh-stack`:

```json
"full_name": "github/gh-stack",
"description": "GitHub Stacked PRs",
"homepage": "https://gh.io/stacks",
"language": "Go",
"license": { "spdx_id": "MIT" },
"stargazers_count": 1022,
"created_at": "2026-02-06T17:49:56Z",
"pushed_at": "2026-08-04T13:12:30Z",
"topics": ["cli", "gh-extension", "github", "stacked-prs"],
"custom_properties": { "ownership-name": "@github/pull-requests" }
```

Owned by GitHub's own `@github/pull-requests` team, MIT licensed, actively pushed
the same day as this research.

`gh extension list` confirms it is installed locally:
`gh stack   github/gh-stack   v0.0.4`.

`gh stack --help` groups its commands as:

- **Stack management** — `add`, `checkout`, `init`, `modify`, `unstack`, `view`
- **Remote operations** — `link`, `push`, `rebase`, `submit`, `sync`
- **Navigation** — `bottom`, `down`, `switch`, `top`, `up`
- **Utilities** — `alias`, `feedback`

Only `view` is a pure read. `gh stack view --help`:

> View the current stack as a list showing branches and PR status.
> The current branch is highlighted. Use `--short` for a compact one-line-per-branch view, or `--json` for machine-readable output.

**`--json` exists, which is tempting — and it is still the wrong tool.** `view`
operates on "the current stack", i.e. the stack of the git repo you are standing
in, resolved through gh-stack's local tracking state. The TUI's premise is a saved
list of *remote* repos scanned without any local checkout. `gh stack view` cannot
express that.

The nearest thing to a remote read is `gh stack checkout`, whose help says it
"queries the GitHub API to discover the stack, **fetches the branches, and sets up
the stack locally**" — a mutating local operation, unusable for a read-only scan.
`gh stack link` is explicitly a write to GitHub.

That the extension has no such command is not my inference: `github/gh-stack`
issue #150, "`gh stack list` - show me my stacks", is **open** and labelled
`feature request` (retrieved via
`GET https://api.github.com/search/issues?q=repo:github/gh-stack+stack+in:title`).
Its label description names the gap directly — "Other CLI gaps: diff vs parent,
**rebuild stack from remote**, close a fully-merged stack locally."

**Recommendation for the downstream decision ticket: do not shell out to
`gh-stack`.** It adds an install-time dependency the user must have, is versioned
`v0.0.4`, is scoped to a local working copy, and would still not answer "what
stacks exist in these five remote repos". Call the REST endpoint — section 2 shows
the data arrives on the PR list you were already fetching, at zero extra cost.

## Open gaps

1. **No live GraphQL verification. This is the one real hole in this file.** Two
   independent blockers, both confirmed rather than assumed:
   - The stored `gh` token is invalid. `gh auth status` reports:
     `X Failed to log in to github.com account ermand (default)` and
     `The token in default is invalid.` The map recorded this account as
     authenticated with `repo` and `read:org`; that is no longer true as of
     2026-08-04.
   - The shell sandbox has **no DNS whatsoever**, so `gh` could not reach the API
     even with a good token. `curl -sS -m 20 https://api.github.com/` returned
     `curl: (6) Could not resolve host: api.github.com`; the same error for
     `docs.github.com` and for `example.com`, so it is total egress loss, not a
     GitHub-specific block. No proxy variables were set.

   All **[LIVE]** results in this file were obtained through the harness's own
   fetcher, which does have network but sends **unauthenticated** requests. That is
   sufficient for REST (anonymous `core` limit is 60/hr and public repos are
   readable) but **useless for GraphQL**: `GET https://api.github.com/rate_limit`
   reports `"graphql": { "limit": 0, "remaining": 0 }`. Anonymous GraphQL is not
   merely rate-limited, it is disallowed. So
   `gh api graphql -f query='{ __type(name: "PullRequest") { fields { name } } }'`
   — the exact introspection the ticket asked for — could not be run by any
   available route.

   Everything in section 3 is quoted from GitHub's own generated schema reference
   and schema changelog, which are first-party and machine-generated from the
   schema, but they are still documentation rather than a live `__type` response.
   **Specifically unverified: that the example query executes, its actual cost in
   rate-limit points, and whether selecting `stack`/`stackEntry` across a 100-node
   `pullRequests` connection trips any per-field limit.** Re-run once a token is
   restored.

   *(Attempted and failed as a workaround: fetching the full SDL from
   <https://docs.github.com/public/fpt/schema.docs.graphql>. The fetcher caps at
   25,291 lines / ~488 KB, which truncates the alphabetically-ordered schema in the
   `M` types — at `MembersCanDeleteReposDisableAuditEntry` — well before
   `PullRequest`. Grepping the truncated artifact for `stack` correctly returned
   nothing, which is an artifact of the truncation and **not** evidence of absence.
   The per-category page at `/en/graphql/reference/pulls` is what finally supplied
   the typed signatures.)*

2. **No private-repo verification.** Every live result came from a public repo via an
   anonymous request. Whether the `stack` key is emitted identically on PRs in
   private repos, and whether the `repo` scope alone suffices for
   `/repos/{owner}/{repo}/stacks`, is untested. I have no strong reason to expect a
   difference — stacks appear to be an ordinary part of the PR resource — but it is
   untested, and the TUI's real workload is private repos.

3. **The `github.blog` changelog post was never read directly.** Its content reaches
   this file only through a web-search summary, which is why no factual claim above
   rests on it. Its canonical URL was not resolved (search returned only
   `vertexaisearch.cloud.google.com` redirector links, not the underlying
   `github.blog/changelog/...` permalink). The only assertions traceable to the
   changelog are the 2026-07-30 preview date and the "rolling out to all
   repositories" phrasing, and the latter is independently corroborated live in
   section 6.

4. **A stack whose PRs live across forks was never observed.** The search summary
   reports that cross-fork stacks are unsupported in the preview, but I did not
   verify that against the API, and I do not know what the `stack` object looks like
   if such a configuration can be produced at all. The get-one payload's
   `head.repo` / `base.repo` sub-objects hint the shape would accommodate it.

5. **Rate-limit cost of the real scan is unmeasured.** All measurements here were on
   the anonymous 60/hr tier. The authenticated cost of
   `GET /repos/{o}/{r}/pulls?state=open` per saved repo — the number the map's
   "Performance target" item is waiting on — was not measured, because no valid
   token was available. Worth carrying to that ticket: section 2 means stack data
   costs **zero additional requests**, so the scan is exactly one paginated PR list
   per repo.

6. **Whether stacks can be disabled per-org or per-repo** is unresolved; see the end
   of section 6.
