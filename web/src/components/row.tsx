/**
 * One PR, as a row.
 *
 * The row itself selects; the title is a link to the forge. That split is the
 * whole interaction model — prq never acts on a PR, so the only outbound verb is
 * "open this somewhere that can".
 */

import { Link } from "@tanstack/react-router";
import { label, type Change } from "../../../src/changes";
import type { PullRequest } from "../../../src/domain";
import { relativeAge } from "../../../src/render";
import {
  Badge,
  checksBadge,
  mergeBadge,
  providerLabel,
  verdictBadge,
} from "./ui";

export function Row({
  pr,
  changes,
  selected,
  now,
}: {
  pr: PullRequest;
  changes: Change[];
  selected: boolean;
  now: Date;
}) {
  const verdict = verdictBadge(pr.verdict);
  const checks = checksBadge(pr.checks);
  const merge = mergeBadge(pr.merge);
  const moved = changes.length > 0;

  return (
    <Link
      to="/"
      search={(prev) => ({ q: prev.q, flat: prev.flat, pr: pr.id })}
      resetScroll={false}
      className={`group flex items-start gap-3 border-l-2 py-2 pr-3 pl-3 transition-colors ${
        selected
          ? "border-l-sky-400 bg-sky-500/10"
          : moved
            ? "border-l-amber-400/70 bg-amber-500/[0.04] hover:bg-zinc-800/60"
            : "border-l-transparent hover:bg-zinc-800/60"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[11px] text-zinc-500">
            {providerLabel(pr.provider)}
          </span>
          <span className="truncate font-mono text-[11px] text-zinc-500">
            {pr.repo}
          </span>
          <span className="font-mono text-[11px] text-zinc-400">#{pr.number}</span>
        </div>

        <div className="mt-0.5 flex items-center gap-2">
          {pr.draft && (
            <span className="shrink-0 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
              draft
            </span>
          )}
          <span
            className={`truncate text-sm ${selected ? "text-white" : "text-zinc-100"}`}
          >
            {pr.title}
          </span>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {verdict && <Badge tone={verdict.tone}>{verdict.text}</Badge>}
          {checks && <Badge tone={checks.tone}>{checks.text}</Badge>}
          {merge && <Badge tone={merge.tone}>{merge.text}</Badge>}
          {pr.viaCodeOwners && (
            <Badge tone="mute" title="Requested via CODEOWNERS, not by name">
              codeowners
            </Badge>
          )}
          {pr.stacks.map((stack) => (
            <Badge
              key={stack.id}
              tone="info"
              title={
                stack.precision === "approximate"
                  ? "Stack position is approximate on this provider"
                  : undefined
              }
            >
              stack {stack.position}/{stack.size}
              {stack.precision === "approximate" && "~"}
            </Badge>
          ))}
          {pr.otherReviews > 0 && (
            <Badge tone="mute">
              {pr.otherReviews} other {pr.otherReviews === 1 ? "review" : "reviews"}
            </Badge>
          )}
          {changes.map((change) => (
            <Badge key={change.kind} tone="urgent">
              {label(change.kind)}
            </Badge>
          ))}
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
        <span className="font-mono text-[11px] text-zinc-500">
          {relativeAge(pr.updatedAt, now)}
        </span>
        <span className="max-w-[9rem] truncate text-[11px] text-zinc-500">
          {pr.author}
        </span>
      </div>
    </Link>
  );
}
