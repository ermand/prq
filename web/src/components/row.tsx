/**
 * One PR, as a row.
 *
 * A single line of aligned columns rather than a stacked block. Stacked, a wide
 * screen put a title and its own age a thousand pixels apart and spent the
 * middle on nothing; in columns the width goes to the title, everything else
 * lines up vertically, and a row costs one line instead of three.
 *
 * Below `lg` the flex container wraps, so the same markup degrades to the
 * stacked form on a narrow window without a second layout to maintain.
 *
 * Two targets that do not overlap: the body selects the row and opens the detail
 * panel, and the arrow at the right edge leaves for the forge. prq never acts on
 * a PR, so "open this somewhere that can" is the only outbound verb — and it
 * gets a permanent, predictable hit area rather than hiding behind a hover.
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

/**
 * A repository path split so the informative end always renders.
 * `a/b/kesh-back` -> prefix `a/b/`, leaf `kesh-back`.
 */
function repoPrefix(repo: string): string {
  const cut = repo.lastIndexOf("/");
  return cut === -1 ? "" : repo.slice(0, cut + 1);
}

function repoLeaf(repo: string): string {
  const cut = repo.lastIndexOf("/");
  return cut === -1 ? repo : repo.slice(cut + 1);
}

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
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 py-1.5 pl-3 hover:bg-zinc-800/60 lg:flex-nowrap"
      >
        {/* Fixed column so the numbers line up down the list.

            The path sits in its own clipping box with the number *outside* it:
            a long single-segment repo used to overflow the column and shunt
            `#22` straight into the title with no gap.

            Within that box the prefix gives way first and the last segment is
            kept, because cutting from the right gave `…/kesh/k…` — losing
            exactly the part that tells `kesh-back` from `kesh-front`. */}
        <span
          title={pr.repo}
          className="flex shrink-0 items-baseline gap-1.5 font-mono text-2xs text-zinc-500 lg:w-[14rem] xl:w-[18rem] 2xl:w-[22rem]"
        >
          <span className="shrink-0 text-zinc-600">
            {providerLabel(pr.provider)}
          </span>
          {/* `shrink` without grow: as `flex-1` the prefix stretched and left a
              gap in the middle of short paths, `nebulaltd/    oddsy-gateway`. */}
          <span className="flex min-w-0 shrink items-baseline">
            <span className="min-w-0 shrink truncate">{repoPrefix(pr.repo)}</span>
            <span className="max-w-full shrink-0 truncate">{repoLeaf(pr.repo)}</span>
          </span>
          <span className="shrink-0 text-zinc-400">#{pr.number}</span>
        </span>

        {/* `shrink` without grow. As `flex-1` the title absorbed all the slack
            and shoved the badges over beside the age, so on a 3000px screen the
            badges describing a PR sat a thousand pixels from its title. */}
        <span className="flex min-w-0 shrink items-baseline gap-2">
          {pr.draft && (
            <span className="shrink-0 text-2xs font-semibold tracking-wide text-zinc-500 uppercase">
              draft
            </span>
          )}
          <span
            className={`truncate text-sm ${selected ? "text-white" : "text-zinc-100"}`}
          >
            {pr.title}
          </span>
        </span>

        <span className="flex shrink-0 flex-wrap items-center gap-1.5 lg:mr-auto">
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
            <Badge tone="mute" title={`${pr.otherReviews} opinionated review(s)`}>
              +{pr.otherReviews}
            </Badge>
          )}
          {changes.map((change) => (
            <Badge key={change.kind} tone="urgent">
              {label(change.kind)}
            </Badge>
          ))}
        </span>

        <span className="w-11 shrink-0 text-right font-mono text-2xs text-zinc-500">
          {relativeAge(pr.updatedAt, now)}
        </span>
        {/* First thing to go when the window is narrow: the author matters least
            of the three, and the detail panel always has it. */}
        <span className="hidden w-28 shrink-0 truncate text-right text-2xs text-zinc-500 xl:block">
          {pr.author}
        </span>
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
