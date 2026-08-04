---
id: 0012
title: Assemble SPEC.md
parent: map
type: task
status: open
assignee: ~
blocked_by: [0004, 0005, 0006, 0007, 0008, 0009, 0010, 0011, 0013]
---

## Question

Nothing left to decide — write the destination document.

Gather every resolution on the map into a single `SPEC.md` an implementation
agent can execute without asking a question. It must carry:

- What the tool is and what it deliberately is not, including the out-of-scope
  list so the implementer does not helpfully add write actions.
- The domain model and state vocabulary.
- Config file location, format, and schema.
- The provider seam.
- Data acquisition: which calls, in what concurrency, with what caching and
  refresh behaviour, and how failures degrade.
- The full UI specification: layout, row composition, grouping and sort, stack
  treatment, keymap, colour usage.
- Acceptance criteria concrete enough to check off.

Link the prototypes and ADRs rather than inlining them. Then re-read the map's
*Not yet specified* section: anything still sitting there when the spec is
written either graduates into the spec or is explicitly named as a known gap.
