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
 *
 * The page also edits two things, because it is the only place with the context
 * to do it: the name, and which forge accounts the name covers. The second one
 * is not cosmetic — the driver's own two accounts measured 659 and 156 pull
 * requests separately, and neither figure was the truth about him. Both edits
 * are one row apiece and both have an undo on this page, so neither is behind a
 * confirmation dialog.
 */

import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { isBot } from "../../../src/census";
import type { PersonInsight } from "../../../src/insights";
import type { PersonDetailPayload } from "../server/census";
import type { LinkableIdentity } from "../server/settings";
import { getLinkable, linkPerson, unlinkAccount } from "../server/settings";
import { MonthBars, Meter, Stat } from "./chart";
import { NameEditor } from "./name-editor";
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
        {/* Still the People page, and it needs a root heading like the rest. */}
        <h1 className="sr-only">People</h1>
        <p className="max-w-md text-center text-body leading-relaxed text-fg-muted">
          No such person. Identities come from the census and from configured
          aliases — <Link to="/people" search={{}} className="text-accent hover:text-fg">back to the roster</Link>.
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
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-muted bg-surface px-4 py-2.5">
        <Link
          to="/people"
          search={{}}
          className="text-meta text-fg-muted hover:text-fg"
        >
          ← people
        </Link>
        {/*
         * The person's name is what this page is about, so it is the `<h1>` —
         * the page previously had no `<h1>` at all and opened at the section
         * `<h2>`s. `min-w-0` keeps the editor's own truncation working now that
         * a block element sits between it and the flex row.
         */}
        <h1 className="flex min-w-0">
          <NameEditor
            id={person.id}
            label={person.label}
            textClass="text-title text-fg"
          />
        </h1>
        {bot && <Badge tone="mute">bot</Badge>}
        {person.aliases.length > 1 && (
          <Badge tone="info">{person.aliases.length} forges</Badge>
        )}
        <span className="ml-auto font-mono text-meta text-fg-muted">{person.id}</span>
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
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** What the last edit did to the figures, said in words rather than implied. */
  const [note, setNote] = useState<string | null>(null);
  /** `null` while the picker is closed, so the ~31 candidates load on demand. */
  const [candidates, setCandidates] = useState<LinkableIdentity[] | null>(null);
  const [loading, setLoading] = useState(false);

  const merged = person.aliases.length > 1;

  async function write(work: () => Promise<unknown>, said: string) {
    setBusy(true);
    setError(null);
    try {
      await work();
      // The store is the truth: the figures on this page are recomputed by the
      // loader, not adjusted here.
      await router.invalidate();
      setCandidates(null);
      setNote(said);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function openPicker() {
    setError(null);
    setNote(null);
    setLoading(true);
    try {
      setCandidates(await getLinkable({ data: { id: person.id } }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Section title="identity" hint="who these numbers belong to">
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="col-span-2">
          <div className="text-label tracking-wide text-fg-muted uppercase">accounts</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {person.aliases.map((alias) => (
              <span
                key={`${alias.provider}:${alias.username}`}
                className="inline-flex items-center gap-1"
              >
                <Badge tone={merged ? "info" : "mute"} title={`${alias.provider} account`}>
                  <span className="text-fg-muted">{providerLabel(alias.provider)}</span>
                  <span className="font-mono">{alias.username}</span>
                </Badge>
                {/* Only offered on a person holding more than one account: the
                    last account cannot be split off something it is all of. */}
                {merged && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void write(
                        () =>
                          unlinkAccount({
                            data: { provider: alias.provider, username: alias.username },
                          }),
                        `${alias.username} stands alone again. The figures below no longer include it.`,
                      )
                    }
                    title={`Split ${alias.username} back into its own identity`}
                    className="text-chip text-fg-subtle hover:text-danger disabled:opacity-50"
                  >
                    unlink
                  </button>
                )}
              </span>
            ))}
            <button
              type="button"
              disabled={loading || busy}
              onClick={() => (candidates === null ? void openPicker() : setCandidates(null))}
              className="rounded border border-border px-1.5 py-0.5 text-chip text-fg-muted hover:border-accent hover:text-accent disabled:opacity-50"
            >
              {loading ? "loading…" : candidates === null ? "link an account" : "close"}
            </button>
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

      {error !== null && <p className="mt-3 text-body text-danger">{error}</p>}
      {note !== null && <p className="mt-3 text-body text-accent">{note}</p>}

      {candidates !== null && (
        <LinkPicker
          candidates={candidates}
          busy={busy}
          onPick={(pick) =>
            void write(
              () => linkPerson({ data: { fromId: pick.id, intoId: person.id } }),
              `${pick.label} folded into ${person.label}. Every figure on this page is now the sum across ` +
                `${person.aliases.length + pick.accounts.length} accounts — unlink above to undo it.`,
            )
          }
        />
      )}

      {merged && (
        <p className="mt-3 text-body leading-relaxed text-fg-muted">
          Every figure below is the sum across{" "}
          {person.aliases.map((alias, i) => (
            <span key={`${alias.provider}:${alias.username}`}>
              {i > 0 && " and "}
              <span className="font-mono text-fg">{alias.username}</span> on{" "}
              {alias.provider}
            </span>
          ))}
          . These are one person because this database says so; prq never merges
          logins across forges by itself, since the same name on two forges is often
          two people. `unlink` undoes it, one account at a time.
        </p>
      )}
    </Section>
  );
}

/**
 * The merge picker: every other identity, filterable, because 31 of them is past
 * the point where scanning beats typing three letters.
 *
 * Bots sort last rather than being hidden. `dependabot` is a legitimate merge
 * target — two forges run their own — but offering it in the first rows of a
 * list whose purpose is "which of these is also me" would be an invitation to
 * mis-click, and a merge moves alias rows rather than deleting anything, so the
 * cost of the mistake is one `unlink`.
 */
function LinkPicker({
  candidates,
  busy,
  onPick,
}: {
  candidates: LinkableIdentity[];
  busy: boolean;
  onPick: (pick: LinkableIdentity) => void;
}) {
  const [needle, setNeedle] = useState("");

  const n = needle.trim().toLowerCase();
  const found = candidates.filter(
    (c) =>
      n === "" ||
      c.label.toLowerCase().includes(n) ||
      c.accounts.some((account) => account.toLowerCase().includes(n)),
  );
  // Same name first, then humans, then bots. The server already orders it this
  // way; re-applied here because filtering re-sorts nothing but the eye expects
  // the obvious candidate to stay at the top.
  const ordered = [...found].sort(
    (a, b) => Number(b.sameName) - Number(a.sameName) || Number(a.bot) - Number(b.bot),
  );

  return (
    <div className="mt-3 rounded border border-border-muted bg-canvas p-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={needle}
          placeholder="filter identities"
          aria-label="Filter identities to link"
          onChange={(e) => setNeedle(e.target.value)}
          className="w-44 rounded border border-border bg-surface px-2 py-0.5 text-chip text-fg placeholder:text-fg-subtle focus:border-accent"
        />
        <span className="text-meta text-fg-muted">
          {ordered.length} of {candidates.length} — linking folds the one you pick into
          this person, who keeps this name and this URL.
        </span>
      </div>

      <ul className="mt-2 max-h-64 space-y-0.5 overflow-y-auto">
        {ordered.map((candidate) => (
          <li
            key={candidate.id}
            className="flex items-center gap-2 rounded px-1 py-1 hover:bg-surface"
          >
            <span className="min-w-0 flex-1 truncate text-body text-fg">
              {candidate.label}
            </span>
            {candidate.sameName && (
              <Badge tone="urgent" title="Identical display name — very likely the same human">
                same name
              </Badge>
            )}
            {candidate.bot && <Badge tone="mute">bot</Badge>}
            <span className="flex shrink-0 items-center gap-1">
              {candidate.accounts.map((account) => (
                <Badge key={account} tone="mute">
                  <span className="text-fg-muted">
                    {providerLabel(account.slice(0, account.indexOf(":")))}
                  </span>
                  <span className="font-mono">
                    {account.slice(account.indexOf(":") + 1)}
                  </span>
                </Badge>
              ))}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => onPick(candidate)}
              className="rounded bg-accent-emphasis px-2 py-0.5 text-chip text-white hover:bg-accent hover:text-canvas disabled:opacity-50"
            >
              link
            </button>
          </li>
        ))}
        {ordered.length === 0 && (
          <li className="px-1 py-1 text-body text-fg-muted">Nothing matches that filter.</li>
        )}
      </ul>
    </div>
  );
}

function Wrote({ person, bot }: { person: PersonInsight; bot: boolean }) {
  return (
    <Section title="what they wrote" hint="pull requests authored">
      {!bot && (
        <p className="mb-3 border-l-2 border-border bg-surface px-3 py-2 text-body leading-relaxed text-fg-muted">
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
          tone="success"
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
    return <p className="mt-4 text-body text-fg-subtle">No pull requests and no reviews.</p>;
  }

  return (
    /*
     * Roles rather than a `<table>`: the header and the rows agree on column
     * widths through shared flex classes, and swapping in table elements would
     * mean re-expressing every one of them as a `<col>`. This wrapper already
     * parents both the header row and the list, so it is the table and nothing
     * new is introduced. No `aria-rowcount`: nothing filters this list, so the
     * rows in the DOM are all the rows there are.
     */
    <div role="table" aria-label="Projects this person worked on" className="mt-4">
      <div
        role="row"
        className="flex items-center gap-3 border-b border-border-muted pb-1 text-label tracking-wide text-fg-muted uppercase"
      >
        <span role="columnheader" className="min-w-0 flex-1">project</span>
        <span role="columnheader" className="w-16 shrink-0 text-right">opened</span>
        <span role="columnheader" className="w-16 shrink-0 text-right">merged</span>
        <span role="columnheader" className="w-16 shrink-0 text-right">closed</span>
        <span role="columnheader" className="w-16 shrink-0 text-right">reviews</span>
        <span role="columnheader" className="w-20 shrink-0 text-right">+lines</span>
        <span role="columnheader" className="w-20 shrink-0 text-right">−lines</span>
      </div>
      {/* `presentation` on the list and its items so the rows flatten up to the
          table instead of arriving wrapped in list semantics. */}
      <ul role="presentation">
        {person.repos.map((repo) => (
          <li role="presentation" key={`${repo.provider}:${repo.repo}`}>
            {/*
             * The link used to be the row itself. A `role="row"` on an anchor
             * takes the link role away, and cells nested inside an anchor are no
             * longer children of the row — so this became the stretched-overlay
             * shape the roster and the project list already use: the row is a
             * `div`, the link covers it, and the cells it sits under are inert.
             */}
            <div
              role="row"
              className="relative flex items-center gap-3 border-b border-border-muted py-1.5 hover:bg-surface"
            >
              <span
                role="cell"
                className="pointer-events-none flex min-w-0 flex-1 items-center gap-1.5"
              >
                <Link
                  to="/repos"
                  search={{ r: `${repo.provider}:${repo.repo}` }}
                  aria-label={`Open ${repo.provider}:${repo.repo}`}
                  className="pointer-events-auto absolute inset-0"
                />
                <span className="font-mono text-meta text-fg-subtle">
                  {providerLabel(repo.provider)}
                </span>
                <span className="truncate text-title text-fg">{repo.repo}</span>
              </span>
              <span
                role="cell"
                className="pointer-events-none w-16 shrink-0 text-right font-mono text-num text-fg"
              >
                {num(repo.opened)}
              </span>
              <span
                role="cell"
                className="pointer-events-none w-16 shrink-0 text-right font-mono text-num text-fg-muted"
              >
                {num(repo.merged)}
              </span>
              <span
                role="cell"
                className="pointer-events-none w-16 shrink-0 text-right font-mono text-num text-fg-muted"
              >
                {num(repo.closed)}
              </span>
              {/* A project somebody only reviews in is still a project they work
                  on. Without this the roster counted three and the profile
                  listed two, for the same person. */}
              <span
                role="cell"
                className="pointer-events-none w-16 shrink-0 text-right font-mono text-num text-accent"
              >
                {repo.reviews === 0 ? "—" : num(repo.reviews)}
              </span>
              <span
                role="cell"
                className="pointer-events-none w-20 shrink-0 text-right font-mono text-num text-success"
              >
                {num(repo.additions)}
              </span>
              <span
                role="cell"
                className="pointer-events-none w-20 shrink-0 text-right font-mono text-num text-danger"
              >
                {num(repo.deletions)}
              </span>
            </div>
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
        <p className="mt-3 text-body leading-relaxed text-fg-muted">
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
    <div className="rounded border border-border-muted bg-surface p-3">
      <div className="flex items-baseline gap-2">
        <span className="text-section text-fg">{title}</span>
        <span className="font-mono text-lead text-fg">{num(stat.total)}</span>
        <span className="text-meta text-fg-muted">{hint}</span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-x-6">
        <Stat label="approved" value={num(stat.approved)} />
        <Stat label="changes requested" value={num(stat.changesRequested)} />
        <Stat label="commented" value={num(stat.commented)} />
      </div>
      {dismissed > 0 && (
        <p className="mt-2 text-body text-fg-subtle">
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
    <section className="rounded border border-border-muted bg-surface">
      {/*
       * The hint is a sibling of the heading, not inside it. Nested, the
       * heading's accessible name measured as `identitywho these numbers belong
       * to` — one run-on string. The row is still the flex container, so the
       * baseline-aligned title and hint render exactly as before.
       */}
      <div className="flex flex-wrap items-baseline gap-x-2 border-b border-border-muted px-3 py-1.5">
        <h2 className="text-section text-fg">{title}</h2>
        <span className="text-meta text-fg-muted">{hint}</span>
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}
