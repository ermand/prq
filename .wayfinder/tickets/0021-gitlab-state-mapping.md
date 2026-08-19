---
id: 0021
title: How GitLab states map onto the taxonomy
parent: map
type: grilling
status: closed
assignee: Main
blocked_by: [0020]
---

## Question

Given what GitLab can and cannot report, what does a merge request's **verdict**,
**standing**, **readiness** and **lifecycle** mean — and what happens to the axes
GitLab cannot fill?

The taxonomy in [0005](./0005-review-state-taxonomy.md) was designed against
GitHub and is now load-bearing: the seven buckets in
[0007](./0007-relevance-buckets-and-sort.md) and the ten change kinds in
[0015](./0015-which-changes-matter.md) both consume it. A second provider that
cannot fill an axis forces a choice that has been deferred until now.

Resolve:

- **Where an axis is unfillable, what is rendered?** A distinct "unknown" value, a
  blank, or the benign default. Note that `merge: unknown` and `checks: none`
  already exist as legitimate non-committal values and are deliberately *not*
  treated as changes — whether provider-unsupported should reuse that machinery or
  be visibly different is the question.
- **If GitLab has no `changes-requested`**, what becomes of buckets 2 and 6?
  Empty for GitLab MRs forever, or filled by a GitLab-shaped proxy such as
  unresolved discussion threads — and if a proxy, whether it is honest to show it
  under a label that means something stricter on GitHub.
- **Whether `staleBlock` is reconstructible on GitLab**, and if not, whether
  bucket 2 is simply GitHub-only. Bucket 2 was argued into existence on measured
  evidence (32 of 40 sampled PRs carried a stale block); losing it silently on
  half the providers would be a quiet regression.
- **Whether the buckets stay identical across providers.** One list with mixed
  rows is the destination, so a bucket that means subtly different things
  depending on the row's origin is a trap.
- **How a row shows which provider it came from**, if at all. The repo path may be
  enough, or it may be ambiguous.
- **Whether the change axes need per-provider suppression**, given a field GitLab
  computes lazily will otherwise produce the same spurious reports the GitHub port
  hit twice.

Record whatever lands in `CONTEXT.md`; the glossary currently describes a
single-provider world.

## Resolution

**Every axis is fillable on GitLab. None is provider-unsupported.** The question
anticipated blanks and proxies; the answer is that GitLab supplies all four axes,
two of them at lower precision, and that precision rides on the row rather than
the provider.

- **Unfillable axis → there are none, but imprecision is explicit.** `staleBlock`
  became three-valued — `null` is "this provider cannot tell", distinct from
  `{value: false}` "it did not move". `null` does *not* reuse the benign default:
  it is visibly different (`~` in the TUI, `may-have-moved` in the headless
  output) and it resolves *toward* action, keeping the row in bucket 2 rather than
  demoting it to 6. Precision is **per-project, not per-provider** —
  `changeRequesters` is null on Free and populated on Ultimate, so the capability
  is discovered per row, not declared per provider.
- **GitLab does have `changes-requested`, from two independent sources.**
  `changeRequesters` on paid projects, and the reviewer's own
  `reviewState: REQUESTED_CHANGES` everywhere — which is what makes it work on the
  driver's Free-tier projects. No proxy was needed and none was invented; buckets
  2 and 6 are genuinely populated for GitLab rows.
- **`staleBlock` is reconstructible.** GitLab records no commit against a review,
  so the sha comparison cannot be ported; the reviewer's `updatedAt` against the
  newest `mergeRequestDiffs` entry is the closest primitive, hence
  `precision: approximate`. It is `null` for the ~20% of blocking reviewers whose
  interaction carries no timestamp. Bucket 2 is not GitHub-only.
- **The buckets are identical across providers.** One definition, one code path.
  What differs is the confidence attached to a row, carried in `precision`, so a
  bucket never means two things.
- **A row shows its provider in the ref.** GitLab paths nest arbitrarily, so the
  last segment is the project name and a `gl:` prefix disambiguates it. Without the
  prefix a project at `evil/facebook/react` would render identically to the GitHub
  repo of that name in the same list.
- **The change axes needed per-provider suppression, and got it.** Two GitLab
  fields fill in lazily and both fired spurious reports before being guarded:
  `diffHeadSha` arrives empty on new MRs (firing `pushed-while-blocked`, which
  outranks nearly everything) and `staleBlock` arrives `null` (firing a bucket move
  reading "your block no longer applies"). Both guards are directional, matching
  the two that already existed for `mergeable` and `statusCheckRollup`. This is now
  four lazily-computed fields caught by the same trap — a pattern, not a series of
  accidents.

Verified live: three consecutive syncs across 28 GitHub PRs and 8 GitLab MRs
report zero changes. Measured during the port: 227 MRs for merge-status
combinations, 311 reviewer records for review states, 175 MRs for the involvement
predicate.
