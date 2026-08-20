/**
 * One person's profile, in three sections: who they are, what they wrote, how
 * they review.
 *
 * The order is deliberate. Identity comes first because on a merged person every
 * number below is a sum across two forges, and a reader who does not know that
 * will read one account's history as if it were the whole. Review comes last
 * because it is the part the forges record worst: GitLab hands over review acts
 * with no timestamp at all, so half the people here can have no latency figure,
 * and a page that led with review would lead with a hole.
 *
 * The caveat above the counts is not boilerplate and is not negotiable. This
 * page was asked for as an employee performance profile, and it cannot be one:
 * the forges record pull requests, review acts and lines, and none of those is
 * the work. Stating that where it is read is cheaper than the alternative, which
 * is somebody comparing two of these side by side and believing the bigger
 * number. Bots skip it — the sentence is about people.
 */

import { Link } from "@tanstack/react-router";
import { isBot } from "../../../src/census";
import type { PersonInsight } from "../../../src/insights";
import type { PersonDetailPayload } from "../server/census";
import { MonthBars, Meter, Stat } from "./chart";
import { Badge, providerLabel } from "./ui";

/** Thousands separators without `toLocaleString`, whose grouping is a locale. */
const num = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * An elapsed-hours figure at the precision a reader can act on. A median of
 * 37.4 hours is "a day and a half"; printing two decimals on a four-month
 * median, which this set contains, is false precision.
 */
function hoursLabel(hours: number | null): string | null {
  if (hours === null) return null;
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 60) return `${days < 10 ? days.toFixed(1) : Math.round(days)}d`;
  return `${Math.round(days / 30.44)}mo`;
}

/** Census timestamps are UTC ISO-8601, so the day is a slice and not a parse. */
const day = (iso: string | null) => (iso === null ? null : iso.slice(0, 10));

export function PersonProfile({ profile }: { profile: PersonDetailPayload }) {
  const person = profile.insight;

  if (person === null) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center">
        <p className="max-w-md text-center text-xs leading-relaxed text-zinc-500">
          No such person. Identities come from the census and from configured
          aliases — <Link to="/people" search={{}} className="text-sky-400 hover:text-sky-300">back to the roster</Link>.
        </p>
      </main>
    );
  }

  const bot = person.aliases.every((alias) => isBot(alias.username));
  const spanYears =
    person.firstSeen === null || person.lastSeen === null
      ? null
      : (Date.parse(person.lastSeen) - Date.parse(person.firstSeen)) / 31_557_600_000;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-800 bg-zinc-900/50 px-4 py-2.5">
        <Link
          to="/people"
          search={{}}
          className="text-xs text-zinc-500 hover:text-zinc-200"
        >
          ← people
        </Link>
        <span className="text-sm font-semibold text-zinc-100">{person.label}</span>
        {bot && <Badge tone="mute">bot</Badge>}
        {person.aliases.length > 1 && (
          <Badge tone="info">{person.aliases.length} forges</Badge>
        )}
        <span className="ml-auto font-mono text-2xs text-zinc-500">{person.id}</span>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {/*
         * Capped in `rem`, so it scales with the root font rather than fighting
         * it. Wide enough for eight stat columns and a GitLab project path
         * (`albanian-technology-distribution/kesh/kesh-back` is 46 characters),
         * and no wider: a 3000px screen would otherwise set the caveat as one
         * 2000px line, which nobody reads.
         */}
        <div className="mx-auto w-full max-w-[76rem] space-y-4 p-4">
          <Identity person={person} spanYears={spanYears} />
          <Wrote person={person} bot={bot} />
          <Reviews person={person} />
        </div>
      </main>
    </div>
  );
}

function Identity({
  person,
  spanYears,
}: {
  person: PersonInsight;
  spanYears: number | null;
}) {
  return (
    <Section title="identity" hint="who these numbers belong to">
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="col-span-2">
          <div className="text-2xs tracking-wide text-zinc-500 uppercase">accounts</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {person.aliases.map((alias) => (
              <Badge
                key={`${alias.provider}:${alias.username}`}
                tone={person.aliases.length > 1 ? "info" : "mute"}
                title={`${alias.provider} account`}
              >
                <span className="opacity-60">{providerLabel(alias.provider)}</span>
                <span className="font-mono">{alias.username}</span>
              </Badge>
            ))}
          </div>
        </div>
        <Stat label="first seen" value={day(person.firstSeen)} />
        <Stat label="last seen" value={day(person.lastSeen)} />
        <Stat
          label="span"
          value={spanYears === null ? null : `${spanYears.toFixed(1)}y`}
          hint="First recorded activity to last, not time employed."
        />
        <Stat label="projects" value={person.repos.length} />
      </div>

      {person.aliases.length > 1 && (
        <p className="mt-3 text-xs leading-relaxed text-zinc-400">
          Every figure below is the sum across{" "}
          {person.aliases.map((alias, i) => (
            <span key={`${alias.provider}:${alias.username}`}>
              {i > 0 && " and "}
              <span className="font-mono text-zinc-200">{alias.username}</span> on{" "}
              {alias.provider}
            </span>
          ))}
          . These are one person because the config says so; prq never merges logins
          across forges by itself, since the same name on two forges is often two
          people.
        </p>
      )}
    </Section>
  );
}

function Wrote({ person, bot }: { person: PersonInsight; bot: boolean }) {
  return (
    <Section title="what they wrote" hint="pull requests authored">
      {!bot && (
        <p className="mb-3 border-l-2 border-zinc-700 bg-zinc-900/50 px-3 py-2 text-xs leading-relaxed text-zinc-400">
          These are counts of pull requests, review acts and lines — not a measure
          of contribution or performance. One pull request is one row whether it is
          a 4000-line generated migration or a one-line fix to a race condition,
          and the forges record no way to tell those apart. Read this page as a
          record of activity, and nothing else.
        </p>
      )}

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 lg:grid-cols-8">
        <Stat label="opened" value={num(person.counts.total)} />
        <Stat label="merged" value={num(person.counts.merged)} />
        <Stat label="closed" value={num(person.counts.closed)} hint="Closed without merging." />
        <Stat label="open" value={num(person.counts.open)} />
        <Stat
          label="median to merge"
          value={hoursLabel(person.medianHoursToMerge)}
          hint="Opened to merged, median over their merged pull requests."
        />
        <Stat label="lines added" value={num(person.additions)} />
        <Stat label="lines removed" value={num(person.deletions)} />
        <Stat label="files touched" value={num(person.files)} />
      </div>

      <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <Meter
          value={person.mergeRate}
          label="merge rate — merged of decided"
          tone="emerald"
        />
        <MonthBars
          points={person.activity.map((month) => ({
            month: month.month,
            a: month.opened,
            b: month.merged,
          }))}
          labelA="opened"
          labelB="merged"
          height={96}
        />
      </div>

      <Repos person={person} />
    </Section>
  );
}

function Repos({ person }: { person: PersonInsight }) {
  if (person.repos.length === 0) {
    return <p className="mt-4 text-2xs text-zinc-600">No authored pull requests.</p>;
  }

  return (
    <div className="mt-4">
      <div className="flex items-center gap-3 border-b border-zinc-800 pb-1 text-2xs tracking-wide text-zinc-500 uppercase">
        <span className="min-w-0 flex-1">project</span>
        <span className="w-16 shrink-0 text-right">opened</span>
        <span className="w-16 shrink-0 text-right">merged</span>
        <span className="w-16 shrink-0 text-right">closed</span>
        <span className="w-20 shrink-0 text-right">+lines</span>
        <span className="w-20 shrink-0 text-right">−lines</span>
      </div>
      <ul>
        {person.repos.map((repo) => (
          <li key={`${repo.provider}:${repo.repo}`}>
            <Link
              to="/repos"
              search={{ r: `${repo.provider}:${repo.repo}` }}
              className="flex items-center gap-3 border-b border-zinc-900 py-1.5 hover:bg-zinc-900/60"
            >
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="font-mono text-2xs text-zinc-600">
                  {providerLabel(repo.provider)}
                </span>
                <span className="truncate text-xs text-zinc-200">{repo.repo}</span>
              </span>
              <span className="w-16 shrink-0 text-right font-mono text-2xs text-zinc-200">
                {num(repo.opened)}
              </span>
              <span className="w-16 shrink-0 text-right font-mono text-2xs text-zinc-400">
                {num(repo.merged)}
              </span>
              <span className="w-16 shrink-0 text-right font-mono text-2xs text-zinc-400">
                {num(repo.closed)}
              </span>
              <span className="w-20 shrink-0 text-right font-mono text-2xs text-emerald-400/80">
                {num(repo.additions)}
              </span>
              <span className="w-20 shrink-0 text-right font-mono text-2xs text-rose-400/80">
                {num(repo.deletions)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Reviews({ person }: { person: PersonInsight }) {
  const approximate = person.reviewPrecision === "approximate";

  return (
    <Section title="how they review" hint="review acts given and received">
      <div className="grid gap-4 lg:grid-cols-2">
        <Acts
          title="given"
          hint="acts they left on pull requests, usually somebody else's"
          stat={person.reviewsGiven}
        />
        <Acts
          title="received"
          hint="acts other people left on theirs"
          stat={person.reviewsReceived}
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Stat
          label="median latency"
          value={approximate ? null : hoursLabel(person.medianReviewLatencyHours)}
          hint="Pull request opened to their review act."
        />
        <Stat
          label="self-merged"
          value={num(person.selfMerged)}
          hint="Their own pull requests, merged by them. Not misconduct on its own — it is what a solo project looks like."
        />
      </div>

      {approximate && (
        <p className="mt-3 text-xs leading-relaxed text-zinc-400">
          No median latency: GitLab records no review timestamps, and this person
          works on GitLab. The acts are counted, the delay before them cannot be —
          so it is left blank rather than averaged over the GitHub half and
          presented as the whole.
        </p>
      )}
    </Section>
  );
}

/**
 * `approved + changesRequested + commented <= total`, deliberately: a dismissed
 * approval is in `total` and in no bucket, because it is no longer an opinion.
 * The remainder is shown when it exists rather than letting the three named
 * numbers silently fail to add up.
 */
function Acts({
  title,
  hint,
  stat,
}: {
  title: string;
  hint: string;
  stat: { approved: number; changesRequested: number; commented: number; total: number };
}) {
  const dismissed = stat.total - stat.approved - stat.changesRequested - stat.commented;

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold text-zinc-200">{title}</span>
        <span className="font-mono text-sm text-zinc-100">{num(stat.total)}</span>
        <span className="text-2xs text-zinc-500">{hint}</span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-x-6">
        <Stat label="approved" value={num(stat.approved)} />
        <Stat label="changes requested" value={num(stat.changesRequested)} />
        <Stat label="commented" value={num(stat.commented)} />
      </div>
      {dismissed > 0 && (
        <p className="mt-2 text-2xs text-zinc-600">
          {num(dismissed)} dismissed — counted in the total, in none of the three,
          because a dismissed approval is not an opinion any more.
        </p>
      )}
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded border border-zinc-800 bg-zinc-900/30">
      <h2 className="flex flex-wrap items-baseline gap-x-2 border-b border-zinc-800 px-3 py-1.5">
        <span className="text-xs font-semibold text-zinc-200">{title}</span>
        <span className="text-2xs text-zinc-500">{hint}</span>
      </h2>
      <div className="p-3">{children}</div>
    </section>
  );
}
