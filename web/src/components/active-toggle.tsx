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
import { ROW_CONTROL } from "./system";

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
        /*
         * The two states are deliberately unequal in weight. Rendered as a
         * bordered pill in both, 34 identical `active` chips marched down the
         * right edge of the projects table — a control that looks the same on
         * every row is chrome, not information, which is the rule `ui.tsx`
         * already states about badges.
         *
         * So `active` is a quiet text control that firms up on hover, and
         * `inactive` keeps the full amber pill. The exceptional state is the loud
         * one. It is *not* hidden until hover: the driver could not find this
         * control when it lived only on the settings page, and a hover-only
         * affordance would recreate exactly that.
         */
        className={`${ROW_CONTROL} ${
          active
            ? "border-transparent text-fg-muted hover:border-border hover:bg-surface hover:text-fg"
            : "border-attention/50 bg-attention/10 text-attention hover:border-attention"
        }`}
      >
        {busy ? "…" : active ? "active" : "inactive"}
      </button>
      {error !== null && <span className="font-mono text-meta text-danger">{error}</span>}
    </span>
  );
}
