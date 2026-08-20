/**
 * "These two are one person" — offered on the roster, where you can see it.
 *
 * The merge itself already existed on the profile page, behind a picker. It was
 * undiscoverable from the list, and the evidence is in the store: the driver
 * named `github:mhysollari` and `gitlab:marin.hysollari` "Marin Hysollari"
 * eighteen seconds apart, which is one human typed twice because linking them
 * was never offered at the moment the duplicate was obvious.
 *
 * Two identical display names is the strongest merge signal available, so the
 * roster says so on the row rather than waiting to be asked.
 */

import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { PersonRow } from "../server/census";
import { linkPerson } from "../server/settings";
import { providerLabel } from "./ui";

/**
 * Groups the visible roster by display name, case- and space-insensitively.
 * Returns only the names held by more than one person — everybody else needs no
 * prompt.
 */
export function sameNameGroups(people: PersonRow[]): Map<string, PersonRow[]> {
  const byName = new Map<string, PersonRow[]>();
  for (const person of people) {
    // Bots are excluded: two machines sharing a name is not a person to merge.
    if (person.bot) continue;
    const key = person.label.trim().toLowerCase();
    const group = byName.get(key);
    if (group) group.push(person);
    else byName.set(key, [person]);
  }
  for (const [key, group] of byName) {
    if (group.length < 2) byName.delete(key);
  }
  return byName;
}

/**
 * Which of a group survives the merge. The busiest one, so the id that stays is
 * the established profile and the URL people already have keeps working.
 * Deterministic on ties, or the two rows would each claim to absorb the other.
 */
export function mergeTarget(group: PersonRow[]): PersonRow {
  return [...group].sort(
    (a, b) => b.opened + b.reviews - (a.opened + a.reviews) || a.id.localeCompare(b.id),
  )[0]!;
}

export function SameNameMerge({
  person,
  group,
}: {
  person: PersonRow;
  group: PersonRow[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = mergeTarget(group);
  const others = group.filter((p) => p.id !== person.id);

  // Shown on the row being absorbed, not on the survivor. One control per pair
  // rather than two that do the same thing, and it reads as an action on *this*
  // row: this account joins that one.
  if (target.id === person.id) return null;

  const into = others.find((p) => p.id === target.id) ?? target;
  const account = into.aliases[0];

  async function merge(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await linkPerson({ data: { fromId: person.id, intoId: target.id } });
      await router.invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="pointer-events-auto relative z-10 flex items-center gap-1.5">
      <button
        type="button"
        onClick={merge}
        disabled={busy}
        title={
          account === undefined
            ? `Merge into ${into.label}`
            : `Same name — merge this into ${account.provider}:${account.username}, ` +
              `so one profile carries both accounts`
        }
        className="rounded border border-attention/50 bg-attention/10 px-1.5 py-0.5 text-chip text-attention hover:border-attention hover:bg-attention/20 disabled:opacity-50"
      >
        {busy ? "merging…" : "same name — merge"}
      </button>
      {error !== null && <span className="font-mono text-meta text-danger">{error}</span>}
    </span>
  );
}
