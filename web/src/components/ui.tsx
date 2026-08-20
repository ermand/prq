/**
 * Shared presentation primitives.
 *
 * The restraint here is driven by measurement, not taste: 28 of 29 GitHub PRs in
 * the live set have `checks: "none"`, so rendering a badge for it would paint
 * noise across the entire board. The rule is that a badge appears only when it
 * says something — a clean merge state and an absent CI run say nothing.
 */

import type { ReactNode } from "react";
import type { BucketId, Checks, MergeState, Verdict } from "../../../src/domain";

export type Tone = "urgent" | "warn" | "good" | "bad" | "info" | "mute";

const TONE: Record<Tone, string> = {
  urgent: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  warn: "bg-orange-500/15 text-orange-300 ring-orange-500/30",
  good: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  bad: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  info: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  mute: "bg-zinc-500/10 text-zinc-400 ring-zinc-500/20",
};

export function Badge({
  tone = "mute",
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium leading-none ring-1 ring-inset ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * A filter that lives in the URL, so it survives a reload and can be shared.
 *
 * Rendered as a link rather than a button precisely because it is navigation:
 * middle-click opens the filtered board in a tab, and the back button undoes
 * the filter. A button would have to reimplement both, badly.
 */
export function Pill({
  active,
  children,
  title,
}: {
  active: boolean;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`rounded border px-2 py-1 text-xs transition-colors ${
        active
          ? "border-sky-600/60 bg-sky-500/15 text-sky-200"
          : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-100"
      }`}
    >
      {children}
    </span>
  );
}

/** Ordered by urgency, matching the bucket order in `domain.ts`. */
export const BUCKET_TONE: Record<BucketId, { bar: string; dot: string }> = {
  1: { bar: "bg-amber-400", dot: "bg-amber-400" },
  2: { bar: "bg-orange-400", dot: "bg-orange-400" },
  3: { bar: "bg-emerald-400", dot: "bg-emerald-400" },
  4: { bar: "bg-rose-400", dot: "bg-rose-400" },
  5: { bar: "bg-sky-400", dot: "bg-sky-400" },
  6: { bar: "bg-zinc-500", dot: "bg-zinc-500" },
  7: { bar: "bg-zinc-700", dot: "bg-zinc-700" },
};

/** `null` means "say nothing" — the state carries no information worth pixels. */
export function verdictBadge(v: Verdict): { tone: Tone; text: string } | null {
  if (v === "approved") return { tone: "good", text: "approved" };
  if (v === "changes-requested") return { tone: "bad", text: "changes requested" };
  if (v === "awaiting-review") return { tone: "mute", text: "awaiting review" };
  return null;
}

export function checksBadge(c: Checks): { tone: Tone; text: string } | null {
  if (c === "failing") return { tone: "bad", text: "ci failing" };
  if (c === "pending") return { tone: "warn", text: "ci running" };
  if (c === "success") return { tone: "good", text: "ci green" };
  // "none" is the overwhelming majority. Silence.
  return null;
}

export function mergeBadge(m: MergeState): { tone: Tone; text: string } | null {
  // "clean" is the expected state and "unknown" is an absence of knowledge.
  return m === "conflicted" ? { tone: "bad", text: "conflicted" } : null;
}

export function providerLabel(provider: string): string {
  return provider === "gitlab" ? "gl" : "gh";
}
