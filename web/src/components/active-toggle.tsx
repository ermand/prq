/**
 * The active/inactive mark, for a project or a person.
 *
 * Deliberately one component for both, because it is one idea: **inactive means
 * prq stops fetching and stops putting it in front of you. It never means the
 * history changed.** An inactive project keeps counting on every page; an
 * inactive person keeps counting in every project's numbers. That was settled by
 * driving the model by hand — the alternative rewrote a project's history every
 * time somebody left.
 *
 * No confirm step. It is one column, instantly reversible, and a dialog would
 * imply a weight this does not carry.
 */

import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

export function ActiveToggle({
  active,
  onToggle,
  what,
  inactiveHint,
}: {
  active: boolean;
  onToggle: (next: boolean) => Promise<unknown>;
  /** Named in the title so the control says what it acts on. */
  what: string;
  /** What stopping actually stops. Different for a project and a person. */
  inactiveHint: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await onToggle(!active);
      await router.invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="pointer-events-auto relative z-10 inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        title={
          active
            ? `${what} is active. Marking it inactive ${inactiveHint}`
            : `${what} is inactive — ${inactiveHint.replace(/^stops/, "not")}. Click to resume.`
        }
        className={`rounded border px-1.5 py-0.5 text-2xs transition-colors disabled:opacity-50 ${
          active
            ? "border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-200"
            : "border-amber-600/50 bg-amber-500/10 text-amber-200 hover:border-amber-500"
        }`}
      >
        {busy ? "…" : active ? "active" : "inactive"}
      </button>
      {error !== null && <span className="font-mono text-2xs text-rose-300">{error}</span>}
    </span>
  );
}
