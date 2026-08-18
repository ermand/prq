---
id: 0018
title: Whether bot pull requests earn their place
parent: map
type: grilling
status: open
assignee: ~
blocked_by: []
---

## Question

Do Dependabot and its kind belong in the dashboard, and if so where?

[0007](./0007-relevance-buckets-and-sort.md) settled "nothing is hidden by
default", on the explicit reasoning that the scan already filters bots: a bot PR
only enters the set if you are a requested reviewer or have commented, so
filtering again would be hiding the same thing twice.

**Running the tool disproved that reasoning.** On the driver's real repositories,
**8 of the 14 PRs in *Awaiting me* are Dependabot dependency bumps** — they
request review from the driver by name, so the scan does not filter them at all.
The premise was wrong, so the conclusion needs revisiting.

Change detection sharpens it. A dependency bump is pushed to often, so any change
axis that fires on a push will be dominated by bots, and the one genuinely
interesting PR in a sync will sit under eight bumps.

Resolve:

- Whether bot PRs are hidden, collapsed, sorted last, or left exactly as they are.
- How a bot is identified. `author.login` matching a list, the `[bot]` suffix, the
  GraphQL `__typename` being `Bot`, or a configured list of logins. Establish
  which is actually reliable rather than assuming.
- Whether the answer differs for the dashboard and for the change report — a bump
  you must review is worth showing once, and worth reporting on every push far
  less.
- Whether this is configuration or a fixed rule, and if configuration, whether it
  lives with the repo list.
- Whether the same treatment should apply to any PR you were added to by
  CODEOWNERS rather than by name — `asCodeOwner` is already available and already
  used as a sort key.

Whatever lands here amends 0007's "nothing hidden by default".
