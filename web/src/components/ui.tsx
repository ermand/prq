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
  urgent: "bg-attention/15 text-attention ring-attention/30",
  warn: "bg-severe/15 text-severe ring-severe/30",
  good: "bg-success/15 text-success ring-success/30",
  bad: "bg-danger/15 text-danger ring-danger/30",
  info: "bg-accent/15 text-accent ring-accent/30",
  mute: "bg-fg-muted/10 text-fg-muted ring-fg-muted/20",
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
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-sans text-chip leading-none ring-1 ring-inset ${TONE[tone]}`}
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
      className={`rounded border px-2 py-1 font-sans text-chip transition-colors ${
        active
          ? "border-accent/60 bg-accent/15 text-accent"
          : "border-border text-fg-muted hover:border-fg-muted hover:text-fg"
      }`}
    >
      {children}
    </span>
  );
}

/** Ordered by urgency, matching the bucket order in `domain.ts`. */
export const BUCKET_TONE: Record<BucketId, { bar: string; dot: string }> = {
  1: { bar: "bg-attention", dot: "bg-attention" },
  2: { bar: "bg-severe", dot: "bg-severe" },
  3: { bar: "bg-success", dot: "bg-success" },
  4: { bar: "bg-danger", dot: "bg-danger" },
  5: { bar: "bg-accent", dot: "bg-accent" },
  6: { bar: "bg-fg-muted", dot: "bg-fg-muted" },
  7: { bar: "bg-fg-subtle", dot: "bg-fg-subtle" },
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
