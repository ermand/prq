/**
 * One PR, as a row.
 *
 * Two distinct targets, deliberately not overlapping: the body selects the row
 * and opens the detail panel, and the arrow at the right edge leaves for the
 * forge. prq never acts on a PR, so "open this somewhere that can" is the only
 * outbound verb — and it gets its own permanent, predictable hit area rather
 * than hiding behind a hover.
 *
 * The two cannot be nested. An `<a href>` inside a router `<Link>` is a nested
 * anchor, which is invalid HTML, so they sit side by side inside the row.
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

const FORGE: Record<PullRequest["provider"], string> = {
  github: "GitHub",
  gitlab: "GitLab",
};

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
    <div
      className={`flex items-stretch border-l-2 transition-colors ${
        selected
          ? "border-l-sky-400 bg-sky-500/10"
          : moved
            ? "border-l-amber-400/70 bg-amber-500/[0.04]"
            : "border-l-transparent"
      }`}
    >
      <Link
        to="/"
        search={(prev) => ({ q: prev.q, flat: prev.flat, pr: pr.id })}
        resetScroll={false}
        className="flex min-w-0 flex-1 items-start gap-3 py-2 pl-3 hover:bg-zinc-800/60"
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
                {pr.otherReviews} other{" "}
                {pr.otherReviews === 1 ? "review" : "reviews"}
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

      <OpenOnForge pr={pr} />
    </div>
  );
}

/**
 * A real anchor, so middle-click and cmd-click open a background tab and the
 * browser's own "copy link address" works — which is why this is not a button
 * with an onClick.
 */
function OpenOnForge({ pr }: { pr: PullRequest }) {
  const where = `${pr.repo}#${pr.number} on ${FORGE[pr.provider]}`;

  if (pr.url === null) {
    // `safeUrl` rejected what the API returned. A dead control would be worse
    // than saying so.
    return (
      <span
        title={`No usable link for ${where} — the API returned an address that was not https`}
        className="flex w-11 shrink-0 items-center justify-center border-l border-zinc-800/80 text-zinc-700"
      >
        <span aria-hidden="true">✕</span>
        <span className="sr-only">No usable link</span>
      </span>
    );
  }

  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer noopener"
      title={`Open ${where}`}
      aria-label={`Open ${where}`}
      className="flex w-11 shrink-0 items-center justify-center border-l border-zinc-800 text-zinc-400 transition-colors hover:bg-sky-500/20 hover:text-sky-200 focus-visible:bg-sky-500/20 focus-visible:text-sky-200"
    >
      <span aria-hidden="true" className="text-base leading-none">
        ↗
      </span>
    </a>
  );
}
