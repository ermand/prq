/**
 * One project's history.
 *
 * This page was three competing layouts behind a `?variant=` switcher — a
 * headline, a report, and a leaderboard, rendering the same `RepoInsight` with
 * genuinely different hierarchies. The report won and is what remains: named
 * questions in order, each with its answer in prose on the left and the evidence
 * on the right, because it is the only one of the three that a reader who does
 * not already know what "p90 4.3d" means can learn anything from. The one thing
 * kept from the headline layout is its opening row of four large figures, which
 * orients faster than any band could; whatever it states, no band restates.
 * The losing layouts live on `prototype/repo-page-variants`.
 *
 * What the page will not do, in any shape:
 *
 * - The median time to merge never appears without p90 beside it. On
 *   `pok-auctions` the two are hours apart and days apart respectively; a
 *   median alone would describe a project nobody works in.
 * - `null` is rendered as "unknown", never as zero. A project with no merged
 *   pull requests has no merge rate, which is not the same as a merge rate of
 *   nought, and `Meter` already refuses to draw an empty bar for it.
 * - GitLab attaches no timestamp to a review, so review latency is not shown
 *   for it at all rather than shown as a guess.
 * - Author and reviewer tables are labelled as counts. This data cannot measure
 *   contribution, and `NOT_A_SCORE` says so beside them, because a ranked list
 *   with a bar chart implies a score whether or not one was intended.
 */

import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { RepoInsight } from "../../../src/insights";
import { relativeAge } from "../../../src/render";
import { MonthBars, Meter, Stat } from "./chart";
import type { RepoDetailPayload } from "../server/census";
import { setProjectActive } from "../server/settings";
import { ActiveToggle } from "./active-toggle";
import { Authors, NOT_A_SCORE, Reviewers } from "./repo-leaderboards";
import { Badge, providerLabel } from "./ui";

/**
 * Hours below two days, days above. 372 hours is a number nobody converts in
 * their head, and "15.5d" is the same fact legible.
 */
function duration(hours: number | null): string {
  if (hours === null) return "unknown";
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function percent(ratio: number | null): string {
  return ratio === null ? "unknown" : `${Math.round(ratio * 100)}%`;
}

/**
 * Both the median and the tail, always together. The pair is the finding: a
 * project can merge half its work inside a day and still leave the other half
 * for a fortnight, and only one of those numbers says so.
 */
function Speed({ insight }: { insight: RepoInsight }) {
  return (
    <span className="font-mono text-fg">
      {duration(insight.medianHoursToMerge)}
      <span className="text-fg-subtle"> → </span>
      <span className="text-fg">{duration(insight.p90HoursToMerge)}</span>
    </span>
  );
}

/**
 * GitHub timestamps every review; GitLab does not record one at all. The second
 * case gets a sentence rather than a number, because the only honest latency for
 * it is no latency.
 */
function PrecisionNote({ insight }: { insight: RepoInsight }) {
  if (insight.reviewPrecision === "exact") {
    return (
      <p className="text-meta text-fg-muted">
        Reviews on this forge carry timestamps, so the acts below are dated exactly.
      </p>
    );
  }
  return (
    <p className="text-meta text-attention">
      This forge records no timestamp on a review, so review latency is unknown here.
      The acts below are counted; when they happened is not stored.
    </p>
  );
}

function Stale({ insight }: { insight: RepoInsight }) {
  if (insight.staleOpen.length === 0) {
    return (
      <p className="text-body text-fg-subtle">
        Nothing open has been waiting more than 30 days.
      </p>
    );
  }
  return (
    <ul className="max-w-4xl space-y-1">
      {insight.staleOpen.map((pr) => (
        <li key={pr.number} className="flex items-baseline gap-2 text-body">
          <span className="w-14 shrink-0 text-right font-mono text-num text-attention">
            {pr.days}d
          </span>
          {pr.url === null ? (
            // `safeUrl` rejected what the API returned. A dead link would be
            // worse than admitting there is nowhere to go.
            <span
              className="w-6 shrink-0 font-mono text-num text-fg-subtle"
              title="The API returned an address that was not https"
            >
              —
            </span>
          ) : (
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer noopener"
              className="w-6 shrink-0 font-mono text-num text-fg-muted hover:text-accent"
            >
              #{pr.number}
            </a>
          )}
          <span className="min-w-0 flex-1 truncate text-fg">{pr.title}</span>
          <span className="shrink-0 text-meta text-fg-subtle">{pr.author}</span>
        </li>
      ))}
    </ul>
  );
}

function Throughput({ insight }: { insight: RepoInsight }) {
  return (
    <MonthBars
      points={insight.throughput.map((m) => ({
        month: m.month,
        a: m.opened,
        b: m.merged,
      }))}
      labelA="opened"
      labelB="merged"
      height={80}
    />
  );
}

/** Where you came from, and what you are on. */
function Header({ detail, insight }: { detail: RepoDetailPayload; insight: RepoInsight }) {
  const now = new Date();
  return (
    <header className="flex shrink-0 flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-border-muted bg-surface px-6 py-3">
      <Link
        to="/repos"
        // Drops the project and keeps everything else: the filter that found
        // this project is what the reader wants to come back to.
        search={(prev) => ({ ...prev, r: undefined })}
        className="text-body text-fg-muted hover:text-accent"
      >
        ← projects
      </Link>
      <h1 className="min-w-0 font-mono text-title text-fg">
        {/* `text-title` carries Primer's semibold, and the forge prefix is not
            part of the name — `font-normal` keeps it at `text-meta`'s weight. */}
        <span className="mr-2 text-meta font-normal text-fg-subtle">
          {providerLabel(insight.provider)}
        </span>
        {insight.repo}
      </h1>
      {detail.failed !== null && (
        <Badge tone="bad" title={detail.failed}>
          census failed
        </Badge>
      )}
      {detail.truncated && (
        <Badge tone="warn" title="Hit the page cap — the oldest history is missing">
          truncated
        </Badge>
      )}
      {/* No `inactive` badge here: the toggle to the right already says the word
          in `attention`, and states it *and* acts. Two identical words side by side is
          the badge rule in `ui.tsx` being broken — a badge earns its place only
          when it says something nothing else does. */}
      <span className="ml-auto flex items-baseline gap-3">
        {detail.censusAt !== null && (
          <span suppressHydrationWarning className="text-meta text-fg-muted">
            censused {relativeAge(detail.censusAt, now)} ago
          </span>
        )}
        <ActiveToggle
          active={detail.active}
          what={`${detail.provider}:${detail.repo}`}
          inactiveHint="stops it being synced and censused; its stored history keeps counting everywhere"
          onToggle={(active) =>
            setProjectActive({
              data: { provider: detail.provider, path: detail.repo, active },
            })
          }
        />
      </span>
    </header>
  );
}

function Figure({
  value,
  label,
  sub,
}: {
  value: string | number;
  label: string;
  sub?: ReactNode;
}) {
  return (
    <div>
      <div className="font-mono text-display text-fg">{value}</div>
      <div className="mt-2 text-body text-fg-muted">{label}</div>
      {sub !== undefined && <div className="mt-1 text-meta text-fg-muted">{sub}</div>}
    </div>
  );
}

/**
 * Four figures, sized to survive a 3000px screen, and nothing else at this
 * weight anywhere on the page.
 *
 * The choice of four is the surviving half of the headline layout, and each
 * caption carries the qualifier the bare number needs: a merge rate is over
 * *decided* requests, coverage is a review by *somebody else*, and the median is
 * never here without p90 under it, because a median alone hides the tail and the
 * tail is the finding on every project in this tool.
 */
function Headline({ insight }: { insight: RepoInsight }) {
  const c = insight.counts;
  return (
    <section className="grid grid-cols-2 gap-8 border-b border-border-muted px-6 py-8 xl:grid-cols-4">
      <Figure
        value={c.total}
        label="pull requests, all states"
        sub={`${c.open} open · ${c.merged} merged · ${c.closed} closed`}
      />
      <Figure
        value={percent(insight.mergeRate)}
        label="of decided requests were merged"
        sub={`${c.closed} closed without merging${insight.draftOpen > 0 ? ` · ${insight.draftOpen} open drafts` : ""}`}
      />
      <Figure
        value={duration(insight.medianHoursToMerge)}
        label="median open-to-merge"
        sub={
          <>
            p90 <span className="text-fg">{duration(insight.p90HoursToMerge)}</span>{" "}
            — the slowest tenth
          </>
        }
      />
      <Figure
        value={percent(insight.reviewCoverage)}
        label="of merges had somebody else's review"
        sub={`${insight.unreviewedMerges} merged unreviewed · ${insight.selfMerged} self-merged`}
      />
    </section>
  );
}

/**
 * One question, its answer in prose, and the evidence beside it. The question is
 * the point: a band that cannot be phrased as something a reader would actually
 * ask does not belong on the page.
 */
function Band({
  question,
  answer,
  children,
}: {
  question: string;
  answer: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid grid-cols-1 gap-4 border-b border-border-muted px-6 py-6 lg:grid-cols-[20rem_minmax(0,1fr)] lg:gap-10">
      <div>
        <h2 className="text-title text-fg">{question}</h2>
        <p className="mt-1.5 text-body leading-relaxed text-fg-muted">{answer}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function Body({ insight }: { insight: RepoInsight }) {
  const c = insight.counts;
  const topAuthor = insight.authors[0];
  const topReviewer = insight.reviewers[0];
  // Concentration, stated rather than implied: "one person opened 45% of them"
  // is the finding a bar chart only hints at.
  const share =
    topAuthor === undefined || c.total === 0
      ? null
      : Math.round((topAuthor.opened / c.total) * 100);

  return (
    <>
      {/* The band that used to open the report — total, open, merged, closed,
          authors as five `Stat`s — is gone: `Headline` states every one of those
          figures above, and a page that says `268 merged` twice in one screen
          teaches a reader to skim past both. */}
      <Headline insight={insight} />

      <Band
        question="How much of it lands, and how fast?"
        answer={
          <>
            {percent(insight.mergeRate)} of decided requests were merged — open ones
            are undecided and stay out of that denominator. Half merge within{" "}
            {duration(insight.medianHoursToMerge)}, but the slowest tenth take{" "}
            {duration(insight.p90HoursToMerge)}.
          </>
        }
      >
        {/* 20rem, not 16: "median → p90 to merge" and its value sat a few
            pixels apart in the narrower column. */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <div className="space-y-3">
            <Meter value={insight.mergeRate} label="merged of decided" tone="success" />
            <div className="flex items-baseline justify-between text-meta">
              <span className="text-fg-muted">median → p90 to merge</span>
              <Speed insight={insight} />
            </div>
            <div className="flex items-baseline justify-between text-meta">
              <span className="text-fg-muted">median size</span>
              <span className="font-mono text-fg">
                <span className="text-success">+{insight.medianAdditions}</span>{" "}
                <span className="text-danger">−{insight.medianDeletions}</span>{" "}
                <span className="text-fg-muted">
                  in {insight.medianFiles} file{insight.medianFiles === 1 ? "" : "s"}
                </span>
              </span>
            </div>
          </div>
          <Throughput insight={insight} />
        </div>
      </Band>

      <Band
        question="Who writes it?"
        answer={
          <>
            {share === null
              ? "Nobody could be named — every account on these pull requests was hidden."
              : `${topAuthor?.username} opened ${share}% of them, of ${insight.authors.length} named authors.`}{" "}
            {NOT_A_SCORE}
          </>
        }
      >
        <Authors authors={insight.authors} max={10} />
      </Band>

      <Band
        question="Who reviews it?"
        answer={
          <>
            {percent(insight.reviewCoverage)} of merged requests had a review from
            somebody other than their author. {insight.unreviewedMerges} merged with
            none, and {insight.selfMerged} were merged by the person who opened them.
            {topReviewer !== undefined && (
              <>
                {" "}
                {topReviewer.username} accounts for the most acts at {topReviewer.total}.
              </>
            )}
          </>
        }
      >
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <div className="space-y-3">
            <Meter value={insight.reviewCoverage} label="merges reviewed by another" />
            <div className="grid grid-cols-2 gap-4">
              <Stat label="unreviewed merges" value={insight.unreviewedMerges} />
              <Stat label="self-merged" value={insight.selfMerged} />
            </div>
            <PrecisionNote insight={insight} />
          </div>
          <Reviewers reviewers={insight.reviewers} max={10} />
        </div>
      </Band>

      <Band
        question="What is stuck?"
        answer={
          <>
            {insight.oldestOpenDays === null
              ? "Nothing is open, so nothing is waiting."
              : `The oldest open request has been waiting ${insight.oldestOpenDays} days.`}{" "}
            Anything past 30 days is listed, newest first, capped at ten.
          </>
        }
      >
        <Stale insight={insight} />
      </Band>
    </>
  );
}

export function RepoDetail({ detail }: { detail: RepoDetailPayload }) {
  const insight = detail.insight;

  if (insight === null) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center">
        <p className="max-w-md text-center text-body leading-relaxed text-fg-muted">
          <span className="font-mono text-fg">{detail.key}</span> has never been
          censused. Add it to the configured projects and run{" "}
          <code className="text-fg">prq census</code>.
        </p>
      </main>
    );
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <Header detail={detail} insight={insight} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-16">
        <Body insight={insight} />
      </div>
    </main>
  );
}
