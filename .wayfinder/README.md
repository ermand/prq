# Local-markdown issue tracker

The default tracker for this repo. Wayfinder maps and tickets are markdown files
with YAML frontmatter.

```
.wayfinder/
  map.md              # the map — label: wayfinder:map
  tickets/NNNN-slug.md  # child issues of the map
  wf.mjs              # frontier query
```

## Frontmatter

| field | meaning |
| --- | --- |
| `id` | zero-padded issue number; the ticket's identity |
| `title` | the ticket's **name** — always refer to tickets by this, never by id |
| `parent` | `map` for every ticket |
| `type` | `research` \| `prototype` \| `grilling` \| `task` (the `wayfinder:<type>` label) |
| `status` | `open` \| `closed` |
| `assignee` | the claim. `~` means unclaimed |
| `blocked_by` | list of ticket ids that must be closed first (native dependency relationship) |

## Wayfinding operations

**Create the map** — write `.wayfinder/map.md` using the template in the wayfinder skill.

**Create a ticket** — write `.wayfinder/tickets/NNNN-slug.md`. Next id is the highest
existing id plus one. Body is `## Question` only.

**Wire blocking** — second pass, after ids exist: set `blocked_by: [0002, 0005]`.

**Claim a ticket** — set `assignee` to the dev driving the map *before any work*.

**Query the frontier** — `node .wayfinder/wf.mjs`. Frontier = `status: open`,
`assignee: ~`, and every id in `blocked_by` closed.

**Resolve a ticket** — append a `## Resolution` section to the ticket body, set
`status: closed`, then append a one-line gist plus link to the map's
*Decisions so far*.

**Rule out of scope** — set `status: closed`, append `## Out of scope` with the
reason, and add one line to the map's *Out of scope* section. Never goes in
*Decisions so far*.
