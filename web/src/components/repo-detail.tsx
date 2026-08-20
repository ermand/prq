/**
 * One project's history, in three competing layouts.
 *
 * This is a prototype and the file says so: `A`, `B` and `C` render the same
 * `RepoInsight` with genuinely different hierarchies, and the floating bar picks
 * between them. They are not three skins. `A` decides that four numbers are the
 * answer and everything else is footnotes; `B` refuses a hierarchy and asks five
 * questions in order, top to bottom; `C` decides the project is its people and
 * demotes every project-level total to a single strip. Exactly one of those
 * beliefs is right for this data, and reading all three is the cheapest way to
 * find out which. The loser layouts and the switcher leave together.
 *
 * What they share is the honesty, not the shape:
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
 *   contribution — a 4000-line generated migration and a 40-line fix to a race
 *   condition are one pull request each — and the caption says so on every
 *   layout, because a ranked list with a bar chart implies a score whether or
 *   not one was intended.
 */

import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { identityKey, isBot } from "../../../src/census";
import type { Provider } from "../../../src/domain";
import type { AuthorStat, RepoInsight, ReviewerStat } from "../../../src/insights";
import { relativeAge } from "../../../src/render";
import { MonthBars, Meter, Stat } from "./chart";
import type { RepoDetailPayload } from "../server/census";
import { setProjectActive } from "../server/settings";
import { ActiveToggle } from "./active-toggle";
import { Badge, providerLabel } from "./ui";
import { VariantBar } from "./variant-bar";

type Variant = "A" | "B" | "C";

/** Shown in the switcher, and nowhere else. */
export const VARIANT_NAMES: Record<Variant, string> = {
  A: "A — Headline",
  B: "B — Report",
  C: "C — Leaderboard",
};

/** The caption that keeps a ranked list from reading as a scoreboard. */
const NOT_A_SCORE =
  "Counts, not contribution. A 4000-line generated migration and a 40-line fix to a race condition are one pull request each.";

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

/** Author line totals reach six figures; the exact digit is never the point. */
function lines(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n);
}

// `identityKey` is the same `${provider}:${username}` the people route parses;
// it is imported rather than restated so the two cannot drift apart.

function PersonLink({
  provider,
  username,
}: {
  provider: Provider;
  username: string;
}) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <Link
        to="/people"
        search={{ id: identityKey(provider, username) }}
        className="min-w-0 truncate text-zinc-100 hover:text-sky-300 hover:underline"
      >
        <span className="mr-1 font-mono text-2xs text-zinc-600">
          {providerLabel(provider)}
        </span>
        {username}
      </Link>
      {isBot(username) && (
        <Badge tone="mute" title="Matched the bot heuristic in census.ts">
          bot
        </Badge>
      )}
    </span>
  );
}

/** A proportion of the leader, drawn behind nothing. Purely a scanning aid. */
function Track({ value, peak }: { value: number; peak: number }) {
  return (
    <span className="block h-1 overflow-hidden rounded-full bg-zinc-800">
      <span
        className="block h-full bg-sky-500/70"
        style={{ width: `${peak === 0 ? 0 : (value / peak) * 100}%` }}
      />
    </span>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-2xs font-semibold tracking-wide text-zinc-500 uppercase">
      {children}
    </h2>
  );
}

/**
 * Both the median and the tail, always together. The pair is the finding: a
 * project can merge half its work inside a day and still leave the other half
 * for a fortnight, and only one of those numbers says so.
 */
function Speed({ insight }: { insight: RepoInsight }) {
  return (
    <span className="font-mono text-zinc-100">
      {duration(insight.medianHoursToMerge)}
      <span className="text-zinc-600"> → </span>
      <span className="text-zinc-300">{duration(insight.p90HoursToMerge)}</span>
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
      <p className="text-2xs text-zinc-500">
        Reviews on this forge carry timestamps, so the acts below are dated exactly.
      </p>
    );
  }
  return (
    <p className="text-2xs text-amber-300/80">
      This forge records no timestamp on a review, so review latency is unknown here.
      The acts below are counted; when they happened is not stored.
    </p>
  );
}

/**
 * Every ranked list stops at 56rem.
 *
 * Uncapped, `B` gave the author column the full 3008px band and put a name two
 * thousand pixels from its own count — the same failure the board's row comment
 * describes. The cap is in `rem`, so it grows with the root font-size instead of
 * shrinking away on the wide screen it exists for.
 */
const LIST = "max-w-4xl space-y-1.5";

function Authors({ authors, max }: { authors: AuthorStat[]; max: number }) {
  if (authors.length === 0) {
    return <p className="text-2xs text-zinc-600">No named authors — every account was hidden.</p>;
  }
  const peak = Math.max(1, ...authors.map((a) => a.opened));
  return (
    <ul className={LIST}>
      {authors.slice(0, max).map((author) => (
        <li
          key={identityKey(author.provider, author.username)}
          // Column widths sized to the widest live values: `268m 14c` and
          // `+948k −453k` on `pok-auctions` both wrapped onto a second line at
          // the sizes this started with, which doubled every row's height.
          className="grid grid-cols-[minmax(0,1fr)_3rem_4.5rem_6.5rem] items-center gap-x-3 text-xs"
        >
          <span className="min-w-0">
            <PersonLink provider={author.provider} username={author.username} />
            <Track value={author.opened} peak={peak} />
          </span>
          <span className="text-right font-mono text-zinc-100">{author.opened}</span>
          <span
            className="text-right font-mono text-2xs whitespace-nowrap text-zinc-500"
            title={`${author.merged} merged, ${author.closed} closed without merging`}
          >
            {author.merged}m {author.closed}c
          </span>
          <span className="text-right font-mono text-2xs whitespace-nowrap text-zinc-500">
            <span className="text-emerald-400/70">+{lines(author.additions)}</span>{" "}
            <span className="text-rose-400/70">−{lines(author.deletions)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Reviewers({ reviewers, max }: { reviewers: ReviewerStat[]; max: number }) {
  if (reviewers.length === 0) {
    return <p className="text-2xs text-zinc-600">No review acts recorded.</p>;
  }
  const peak = Math.max(1, ...reviewers.map((r) => r.total));
  return (
    <ul className={LIST}>
      {reviewers.slice(0, max).map((reviewer) => (
        <li
          key={identityKey(reviewer.provider, reviewer.username)}
          className="grid grid-cols-[minmax(0,1fr)_3rem_8rem] items-center gap-x-3 text-xs"
        >
          <span className="min-w-0">
            <PersonLink provider={reviewer.provider} username={reviewer.username} />
            <Track value={reviewer.total} peak={peak} />
          </span>
          <span className="text-right font-mono text-zinc-100">{reviewer.total}</span>
          {/* Approvals, changes requested, comments. They do not sum to the
              total: a dismissed approval counts once here and in no bucket. */}
          <span
            className="text-right font-mono text-2xs whitespace-nowrap text-zinc-500"
            title={`${reviewer.approved} approved, ${reviewer.changesRequested} changes requested, ${reviewer.commented} commented`}
          >
            <span className="text-emerald-400/70">{reviewer.approved}</span>
            {" / "}
            <span className="text-rose-400/70">{reviewer.changesRequested}</span>
            {" / "}
            {reviewer.commented}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Stale({ insight }: { insight: RepoInsight }) {
  if (insight.staleOpen.length === 0) {
    return (
      <p className="text-2xs text-zinc-600">
        Nothing open has been waiting more than 30 days.
      </p>
    );
  }
  return (
    <ul className="max-w-4xl space-y-1">
      {insight.staleOpen.map((pr) => (
        <li key={pr.number} className="flex items-baseline gap-2 text-xs">
          <span className="w-14 shrink-0 text-right font-mono text-2xs text-amber-300/80">
            {pr.days}d
          </span>
          {pr.url === null ? (
            // `safeUrl` rejected what the API returned. A dead link would be
            // worse than admitting there is nowhere to go.
            <span
              className="w-6 shrink-0 font-mono text-2xs text-zinc-700"
              title="The API returned an address that was not https"
            >
              —
            </span>
          ) : (
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer noopener"
              className="w-6 shrink-0 font-mono text-2xs text-zinc-500 hover:text-sky-300"
            >
              #{pr.number}
            </a>
          )}
          <span className="min-w-0 flex-1 truncate text-zinc-300">{pr.title}</span>
          <span className="shrink-0 text-2xs text-zinc-600">{pr.author}</span>
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

/** The header every layout shares: where you came from, and what you are on. */
function Header({ detail, insight }: { detail: RepoDetailPayload; insight: RepoInsight }) {
  const now = new Date();
  return (
    <header className="flex shrink-0 flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-zinc-800 bg-zinc-900/50 px-6 py-3">
      <Link
        to="/repos"
        // Drops the project and keeps everything else: the filter that found
        // this project is what the reader wants to come back to.
        search={(prev) => ({ ...prev, r: undefined })}
        className="text-xs text-zinc-500 hover:text-sky-300"
      >
        ← projects
      </Link>
      <h1 className="min-w-0 font-mono text-base text-zinc-100">
        <span className="mr-2 text-2xs text-zinc-600">
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
          in amber, and states it *and* acts. Two identical words side by side is
          the badge rule in `ui.tsx` being broken — a badge earns its place only
          when it says something nothing else does. */}
      <span className="ml-auto flex items-baseline gap-3">
        {detail.censusAt !== null && (
          <span suppressHydrationWarning className="text-2xs text-zinc-500">
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

export function RepoDetail({
  detail,
  variant,
  variants,
}: {
  detail: RepoDetailPayload;
  variant: Variant;
  variants: readonly Variant[];
}) {
  const insight = detail.insight;

  if (insight === null) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center">
        <p className="max-w-md text-center text-xs leading-relaxed text-zinc-500">
          <span className="font-mono text-zinc-300">{detail.key}</span> has never been
          censused. Add it to the configured projects and run{" "}
          <code className="text-zinc-300">prq census</code>.
        </p>
      </main>
    );
  }

  const Body = { A: HeadlineLayout, B: ReportLayout, C: LeaderboardLayout }[variant];

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <Header detail={detail} insight={insight} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-16">
        <Body insight={insight} />
      </div>
      <VariantBar variants={variants} current={variant} names={VARIANT_NAMES} />
    </main>
  );
}

/* ------------------------------------------------------------------------- *
 * A — Headline
 *
 * The bet: four numbers answer the question, and a reader who wants more will
 * look down. Everything decisive is set at a size that survives a 3000px
 * screen, and the detail is two columns of small print underneath.
 * ------------------------------------------------------------------------- */

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
      <div className="font-mono text-4xl leading-none text-zinc-100">{value}</div>
      <div className="mt-2 text-xs text-zinc-400">{label}</div>
      {sub !== undefined && <div className="mt-1 text-2xs text-zinc-500">{sub}</div>}
    </div>
  );
}

function HeadlineLayout({ insight }: { insight: RepoInsight }) {
  const c = insight.counts;
  return (
    <>
      <section className="grid grid-cols-2 gap-8 border-b border-zinc-800 px-6 py-8 xl:grid-cols-4">
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
              p90 <span className="text-zinc-300">{duration(insight.p90HoursToMerge)}</span>{" "}
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

      <div className="grid grid-cols-1 divide-y divide-zinc-800 xl:grid-cols-2 xl:divide-x xl:divide-y-0">
        <div className="space-y-6 px-6 py-5">
          <section>
            <SectionTitle>Throughput</SectionTitle>
            <div className="mt-2">
              <Throughput insight={insight} />
            </div>
          </section>

          <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="median +" value={insight.medianAdditions} />
            <Stat label="median −" value={insight.medianDeletions} />
            <Stat label="median files" value={insight.medianFiles} />
            <Stat
              label="oldest open"
              value={insight.oldestOpenDays === null ? null : `${insight.oldestOpenDays}d`}
            />
          </section>

          <section>
            <SectionTitle>Open more than 30 days</SectionTitle>
            <div className="mt-2">
              <Stale insight={insight} />
            </div>
          </section>
        </div>

        <div className="space-y-6 px-6 py-5">
          <section>
            <SectionTitle>Authors — {insight.authors.length}</SectionTitle>
            <p className="mt-1 text-2xs text-zinc-600">{NOT_A_SCORE}</p>
            <div className="mt-2">
              <Authors authors={insight.authors} max={12} />
            </div>
          </section>

          <section>
            <SectionTitle>Reviewers — {insight.reviewers.length}</SectionTitle>
            <div className="mt-1">
              <PrecisionNote insight={insight} />
            </div>
            <div className="mt-2">
              <Reviewers reviewers={insight.reviewers} max={12} />
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------------- *
 * B — Report
 *
 * The bet: there is no single headline, only an order. Five full-width bands,
 * each one question with its answer in prose on the left and the evidence on
 * the right, read top to bottom like a page of a report. Nothing competes for
 * attention because nothing is bigger than anything else.
 * ------------------------------------------------------------------------- */

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
    <section className="grid grid-cols-1 gap-4 border-b border-zinc-800 px-6 py-6 lg:grid-cols-[20rem_minmax(0,1fr)] lg:gap-10">
      <div>
        <h2 className="text-sm font-medium text-zinc-100">{question}</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">{answer}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function ReportLayout({ insight }: { insight: RepoInsight }) {
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
      <Band
        question="How much is here?"
        answer={
          <>
            {c.total} pull requests across every state, from {insight.authors.length}{" "}
            named authors. {c.open} are still open
            {insight.draftOpen > 0 && `, ${insight.draftOpen} of them drafts`}.
          </>
        }
      >
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Stat label="total" value={c.total} />
          <Stat label="open" value={c.open} hint={`${insight.draftOpen} drafts`} />
          <Stat label="merged" value={c.merged} />
          <Stat label="closed" value={c.closed} />
          <Stat label="authors" value={insight.authors.length} />
        </div>
      </Band>

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
            <Meter value={insight.mergeRate} label="merged of decided" tone="emerald" />
            <div className="flex items-baseline justify-between text-2xs">
              <span className="text-zinc-500">median → p90 to merge</span>
              <Speed insight={insight} />
            </div>
            <div className="flex items-baseline justify-between text-2xs">
              <span className="text-zinc-500">median size</span>
              <span className="font-mono text-zinc-300">
                <span className="text-emerald-400/70">+{insight.medianAdditions}</span>{" "}
                <span className="text-rose-400/70">−{insight.medianDeletions}</span>{" "}
                <span className="text-zinc-500">
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
              : `${topAuthor?.username} opened ${share}% of them.`}{" "}
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

/* ------------------------------------------------------------------------- *
 * C — Leaderboard
 *
 * The bet: a project is its people, and the totals are context. Both tables get
 * the full page side by side and run deeper than the other layouts, while every
 * repo-level figure is compressed into one strip along the top — deliberately
 * small, because on this data the totals are the part that never changes.
 * ------------------------------------------------------------------------- */

function Cell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <span className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-2xs text-zinc-500">{label}</span>
      <span className="font-mono text-xs text-zinc-100">{value}</span>
    </span>
  );
}

function LeaderboardLayout({ insight }: { insight: RepoInsight }) {
  const c = insight.counts;
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b border-zinc-800 bg-zinc-900/40 px-6 py-2.5">
        <Cell label="prs" value={c.total} />
        <Cell label="open" value={insight.draftOpen > 0 ? `${c.open} (${insight.draftOpen} draft)` : c.open} />
        <Cell label="merged" value={c.merged} />
        <Cell label="closed" value={c.closed} />
        <Cell label="merge rate" value={percent(insight.mergeRate)} />
        <Cell label="median → p90" value={<Speed insight={insight} />} />
        <Cell label="median size" value={`+${insight.medianAdditions} −${insight.medianDeletions} / ${insight.medianFiles}f`} />
        <Cell label="reviewed" value={percent(insight.reviewCoverage)} />
        <Cell label="unreviewed merges" value={insight.unreviewedMerges} />
        <Cell label="self-merged" value={insight.selfMerged} />
        <Cell
          label="oldest open"
          value={insight.oldestOpenDays === null ? "—" : `${insight.oldestOpenDays}d`}
        />
      </div>

      <p className="border-b border-zinc-800 px-6 py-2 text-2xs text-zinc-500">
        {NOT_A_SCORE}
      </p>

      <div className="grid grid-cols-1 divide-y divide-zinc-800 xl:grid-cols-2 xl:divide-x xl:divide-y-0">
        <section className="px-6 py-5">
          {/* Capped to match `LIST`, or the column caption drifts away from the
              columns it names. */}
          <div className="flex max-w-4xl items-baseline gap-2">
            <SectionTitle>Authors</SectionTitle>
            <span className="font-mono text-2xs text-zinc-600">
              {insight.authors.length}
            </span>
            <span className="ml-auto font-mono text-2xs text-zinc-600">
              opened · merged/closed · lines
            </span>
          </div>
          <div className="mt-3">
            <Authors authors={insight.authors} max={25} />
          </div>
        </section>

        <section className="px-6 py-5">
          <div className="flex max-w-4xl items-baseline gap-2">
            <SectionTitle>Reviewers</SectionTitle>
            <span className="font-mono text-2xs text-zinc-600">
              {insight.reviewers.length}
            </span>
            <span className="ml-auto font-mono text-2xs text-zinc-600">
              acts · approved/changes/comments
            </span>
          </div>
          <div className="mt-1.5">
            <PrecisionNote insight={insight} />
          </div>
          <div className="mt-3">
            <Reviewers reviewers={insight.reviewers} max={25} />
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 gap-6 border-t border-zinc-800 px-6 py-5 xl:grid-cols-2">
        <section>
          <SectionTitle>Throughput</SectionTitle>
          <div className="mt-2">
            <Throughput insight={insight} />
          </div>
        </section>
        <section>
          <SectionTitle>Open more than 30 days</SectionTitle>
          <div className="mt-2">
            <Stale insight={insight} />
          </div>
        </section>
      </div>
    </>
  );
}
