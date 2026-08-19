---
id: 0021
title: How GitLab states map onto the taxonomy
parent: map
type: grilling
status: open
assignee: ~
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
