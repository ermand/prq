/**
 * Analysis over census rows: repo dashboards and contributor profiles.
 *
 * Pure by construction — no I/O, no store, no clock. `now` arrives as an
 * argument because every window here (stale age, month series) is relative to
 * it, and a module that reads the clock itself cannot be tested without
 * sleeping. The project forbids wall-clock timers in tests for that reason.
 *
 * Two rules run through the whole file:
 *
 * Medians, not means. Both distributions the census carries are savagely
 * skewed — a 4000-line refactor and a PR that sat open over a holiday are not
 * outliers to be smoothed, they are single rows that would otherwise define a
 * whole profile. `p90HoursToMerge` sits beside the median so the tail stays
 * visible instead of being averaged away.
 *
 * Null means "cannot tell", never zero. A repo with no merged pull requests has
 * no time-to-merge, and reporting 0 would read as "merged instantly". GitLab
 * carries no review timestamps at all, so anything latency-shaped is withheld
 * there rather than imputed. This is the same posture as `StaleBlock` in
 * domain.ts: an unknown is reported as unknown.
 */

import { identityKey, type CensusPr, type CensusReview, type Person } from "./census";
import type { Precision, Provider } from "./domain";

export interface StateCounts {
  open: number;
  merged: number;
  closed: number;
  total: number;
}

/**
 * One author's output. Diff volume is summed here rather than averaged: the
 * leaderboard answers "how much landed", and the per-PR shape lives in the
 * repo-level medians.
 */
export interface AuthorStat {
  provider: Provider;
  username: string;
  opened: number;
  merged: number;
  closed: number;
  additions: number;
  deletions: number;
}

/**
 * One reviewer's acts. `total` counts every act including `dismissed`, which is
 * deliberately absent from the three named buckets — a dismissed approval is no
 * longer an opinion, and folding it into `approved` or `commented` would inflate
 * the reviewer. So `approved + changesRequested + commented <= total`.
 */
export interface ReviewerStat {
  provider: Provider;
  username: string;
  approved: number;
  changesRequested: number;
  commented: number;
  total: number;
}

export interface RepoInsight {
  provider: Provider;
  repo: string;
  counts: StateCounts;
  draftOpen: number;
  medianHoursToMerge: number | null;
  p90HoursToMerge: number | null;
  mergeRate: number | null;
  medianAdditions: number;
  medianDeletions: number;
  medianFiles: number;
  reviewCoverage: number | null;
  unreviewedMerges: number;
  selfMerged: number;
  authors: AuthorStat[];
  reviewers: ReviewerStat[];
  throughput: { month: string; opened: number; merged: number }[];
  oldestOpenDays: number | null;
  staleOpen: { number: number; title: string; url: string | null; author: string; days: number }[];
  reviewPrecision: Precision;
}

export interface PersonInsight {
  id: string;
  label: string;
  aliases: { provider: Provider; username: string }[];
  counts: StateCounts;
  medianHoursToMerge: number | null;
  mergeRate: number | null;
  additions: number;
  deletions: number;
  files: number;
  /**
   * Per project, authored **and** reviewed. A project where somebody only
   * reviewed still belongs here: leaving it out made a reviewer's profile claim
   * fewer projects than the roster did for the same person, and for a
   * reviewer-only identity it hid where they work entirely.
   */
  repos: {
    provider: Provider;
    repo: string;
    opened: number;
    merged: number;
    closed: number;
    additions: number;
    deletions: number;
    reviews: number;
  }[];
  reviewsGiven: ReviewerStat;
  reviewsReceived: ReviewerStat;
  medianReviewLatencyHours: number | null;
  reviewPrecision: Precision;
  activity: { month: string; opened: number; merged: number; reviews: number }[];
  firstSeen: string | null;
  lastSeen: string | null;
  selfMerged: number;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A pull request open this long is not "in review" any more. */
const STALE_DAYS = 30;

/** The stale list is a prompt to act, not an inventory. Ten is a screenful. */
const STALE_CAP = 10;

/**
 * Ceiling on a month series. A single corrupt year (`0001-01-01`) would
 * otherwise expand to twenty thousand entries and drown the caller; 600 months
 * is fifty years, far past any real project, and the *recent* end is kept.
 */
const MAX_MONTHS = 600;

const asc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const prKey = (row: { provider: Provider; repo: string; number: number }) =>
  `${row.provider}:${row.repo}:${row.number}`;

/**
 * Order statistic by linear interpolation between neighbours (the R-7 / NumPy
 * default). At q=0.5 this is the textbook median, averaging the two middle
 * values on an even count. Null on empty input — see the file header.
 */
function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Hour and day figures are display quantities; millisecond floats are noise. */
const round2 = (value: number) => Math.round(value * 100) / 100;

function median(values: number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  const value = quantile(sorted, 0.5);
  return value === null ? null : round2(value);
}

/** Median and p90 in one pass over one sort — the tail beside the centre. */
function spread(values: number[]): { median: number | null; p90: number | null } {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = quantile(sorted, 0.5);
  const tail = quantile(sorted, 0.9);
  return {
    median: mid === null ? null : round2(mid),
    p90: tail === null ? null : round2(tail),
  };
}

/**
 * Elapsed hours, or null when either end is missing or unparseable. Clamped at
 * zero: a review dated before its pull request is a provider lying, and negative
 * latency is worse than no latency.
 */
function hoursBetween(from: string | null, to: string | null): number | null {
  if (from === null || to === null) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, (end - start) / HOUR);
}

const MONTH_PREFIX = /^\d{4}-\d{2}-/;

/**
 * `YYYY-MM` in UTC. Census timestamps came through `canonicalTime`, so they are
 * already UTC ISO-8601 and the prefix is the answer — no Date allocated per row,
 * which matters at 5384 rows. The parse is the fallback for anything else.
 */
function monthKey(iso: string | null): string | null {
  if (iso === null) return null;
  if (MONTH_PREFIX.test(iso)) return iso.slice(0, 7);
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const at = new Date(ms);
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

interface MonthTally {
  opened: number;
  merged: number;
  reviews: number;
}

/**
 * Every calendar month from the earliest tallied one to `now`, ascending,
 * including the empty ones. A sparkline that compresses a quiet month reads as
 * continuous activity, which is the opposite of the truth.
 *
 * The end is `max(now, latest tallied month)` rather than `now` flatly: a
 * provider clock running ahead must not silently drop rows off the end.
 */
function monthSeries(tally: Map<string, MonthTally>, now: Date): { month: string; row: MonthTally }[] {
  if (tally.size === 0) return [];

  let first = "";
  let last = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  for (const key of tally.keys()) {
    if (first === "" || key < first) first = key;
    if (key > last) last = key;
  }

  let year = Number(first.slice(0, 4));
  let month = Number(first.slice(5, 7)) - 1;
  const endYear = Number(last.slice(0, 4));
  const endMonth = Number(last.slice(5, 7)) - 1;

  let span = (endYear - year) * 12 + (endMonth - month) + 1;
  if (span < 1) span = 1;
  if (span > MAX_MONTHS) {
    // Keep the recent end; a nonsense-old row loses its empty prefix, not its data.
    const drop = span - MAX_MONTHS;
    month += drop;
    year += Math.floor(month / 12);
    month %= 12;
    span = MAX_MONTHS;
  }

  const series: { month: string; row: MonthTally }[] = [];
  for (let i = 0; i < span; i++) {
    const key = `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}`;
    series.push({ month: key, row: tally.get(key) ?? { opened: 0, merged: 0, reviews: 0 } });
    month++;
    if (month === 12) {
      month = 0;
      year++;
    }
  }
  return series;
}

/**
 * Counts one event into its month. A null key means the provider gave no usable
 * timestamp, and an event that cannot be placed in time is dropped rather than
 * dated by guess.
 */
function tallyInto(
  tally: Map<string, MonthTally>,
  key: string | null,
  field: keyof MonthTally,
): void {
  if (key === null) return;
  let row = tally.get(key);
  if (row === undefined) {
    row = { opened: 0, merged: 0, reviews: 0 };
    tally.set(key, row);
  }
  row[field]++;
}

function countStates(prs: CensusPr[]): StateCounts {
  const counts: StateCounts = { open: 0, merged: 0, closed: 0, total: prs.length };
  for (const pr of prs) counts[pr.state]++;
  return counts;
}

/** Merged over decided. Open pull requests are undecided; counting them in the
 * denominator makes a busy repo look like a failing one. */
function mergeRateOf(counts: StateCounts): number | null {
  const decided = counts.merged + counts.closed;
  return decided === 0 ? null : counts.merged / decided;
}

function addAct(stat: ReviewerStat, act: CensusReview["act"]): void {
  stat.total++;
  if (act === "approved") stat.approved++;
  else if (act === "changes-requested") stat.changesRequested++;
  else if (act === "commented") stat.commented++;
}

/**
 * Non-empty reviewers per pull request. An empty login is an account the API
 * hid; it cannot be compared against an author, so it is dropped rather than
 * credited as independent review.
 */
function reviewersByPr(reviews: CensusReview[]): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const review of reviews) {
    if (review.reviewer === "") continue;
    const key = prKey(review);
    const list = by.get(key);
    if (list === undefined) by.set(key, [review.reviewer]);
    else list.push(review.reviewer);
  }
  return by;
}

/** A merged PR counts as covered only if somebody other than its author acted. */
function covered(pr: CensusPr, by: Map<string, string[]>): boolean {
  const list = by.get(prKey(pr));
  if (list === undefined) return false;
  for (const reviewer of list) if (reviewer !== pr.author) return true;
  return false;
}

function ageDays(createdAt: string, now: Date): number | null {
  const start = Date.parse(createdAt);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, (now.getTime() - start) / DAY);
}

export function repoInsight(
  prs: CensusPr[],
  reviews: CensusReview[],
  reviewPrecision: Precision,
  now: Date,
): RepoInsight {
  const counts = countStates(prs);
  const byPr = reviewersByPr(reviews);

  const mergeHours: number[] = [];
  const additions: number[] = [];
  const deletions: number[] = [];
  const files: number[] = [];
  const tally = new Map<string, MonthTally>();
  const authors = new Map<string, AuthorStat>();

  let draftOpen = 0;
  let unreviewedMerges = 0;
  let selfMerged = 0;
  let oldestOpen: number | null = null;
  // Exact age travels beside each entry: sorting on the rounded `days` would
  // let two PRs from the same day fall into input order.
  const stale: { entry: RepoInsight["staleOpen"][number]; age: number }[] = [];

  for (const pr of prs) {
    additions.push(pr.additions);
    deletions.push(pr.deletions);
    files.push(pr.files);

    tallyInto(tally, monthKey(pr.createdAt), "opened");

    if (pr.state === "merged") {
      tallyInto(tally, monthKey(pr.mergedAt), "merged");
      const hours = hoursBetween(pr.createdAt, pr.mergedAt);
      if (hours !== null) mergeHours.push(hours);
      if (!covered(pr, byPr)) unreviewedMerges++;
      // Merged by its own author. Both sides must be named — two hidden
      // accounts are not evidence of anything.
      if (pr.author !== "" && pr.author === pr.mergedBy) selfMerged++;
    }

    if (pr.state === "open") {
      if (pr.draft) draftOpen++;
      const age = ageDays(pr.createdAt, now);
      if (age !== null) {
        if (oldestOpen === null || age > oldestOpen) oldestOpen = age;
        if (age > STALE_DAYS) {
          stale.push({
            entry: {
              number: pr.number,
              title: pr.title,
              url: pr.url,
              author: pr.author,
              days: Math.floor(age),
            },
            age,
          });
        }
      }
    }

    // A hidden author would otherwise pool every deleted account into one
    // phantom top contributor. It still counts in `counts`, just not by name.
    if (pr.author !== "") {
      const key = identityKey(pr.provider, pr.author);
      let stat = authors.get(key);
      if (stat === undefined) {
        stat = {
          provider: pr.provider,
          username: pr.author,
          opened: 0,
          merged: 0,
          closed: 0,
          additions: 0,
          deletions: 0,
        };
        authors.set(key, stat);
      }
      stat.opened++;
      if (pr.state === "merged") stat.merged++;
      else if (pr.state === "closed") stat.closed++;
      stat.additions += pr.additions;
      stat.deletions += pr.deletions;
    }
  }

  const reviewers = new Map<string, ReviewerStat>();
  for (const review of reviews) {
    if (review.reviewer === "") continue;
    const key = identityKey(review.provider, review.reviewer);
    let stat = reviewers.get(key);
    if (stat === undefined) {
      stat = {
        provider: review.provider,
        username: review.reviewer,
        approved: 0,
        changesRequested: 0,
        commented: 0,
        total: 0,
      };
      reviewers.set(key, stat);
    }
    addAct(stat, review.act);
  }

  const hours = spread(mergeHours);
  // Coverage is over merged pull requests only: an open PR has not finished
  // collecting reviews, and counting it would report every busy repo as lax.
  const reviewCoverage =
    counts.merged === 0 ? null : (counts.merged - unreviewedMerges) / counts.merged;

  const sample = prs[0] ?? reviews[0];

  return {
    provider: sample?.provider ?? "github",
    repo: sample?.repo ?? "",
    counts,
    draftOpen,
    medianHoursToMerge: hours.median,
    p90HoursToMerge: hours.p90,
    mergeRate: mergeRateOf(counts),
    medianAdditions: median(additions) ?? 0,
    medianDeletions: median(deletions) ?? 0,
    medianFiles: median(files) ?? 0,
    reviewCoverage,
    unreviewedMerges,
    selfMerged,
    authors: [...authors.values()].sort(
      (a, b) =>
        b.opened - a.opened ||
        b.merged - a.merged ||
        asc(a.username, b.username) ||
        asc(a.provider, b.provider),
    ),
    reviewers: [...reviewers.values()].sort(
      (a, b) =>
        b.total - a.total ||
        b.approved - a.approved ||
        asc(a.username, b.username) ||
        asc(a.provider, b.provider),
    ),
    throughput: monthSeries(tally, now).map((entry) => ({
      month: entry.month,
      opened: entry.row.opened,
      merged: entry.row.merged,
    })),
    oldestOpenDays: oldestOpen === null ? null : Math.floor(oldestOpen),
    // Newest first: a PR that has only just gone stale is still recoverable,
    // and the cap means the list must show those. The number tiebreak keeps
    // identical ages from falling into input order.
    staleOpen: stale
      .sort((a, b) => a.age - b.age || a.entry.number - b.entry.number)
      .slice(0, STALE_CAP)
      .map((row) => row.entry),
    reviewPrecision,
  };
}

/**
 * One human's profile across every forge they hold an identity on.
 *
 * Matching is by `(provider, username)`, never by bare login: `ermand` on GitHub
 * and `ermand` on GitLab may well be two different people, and merging them
 * would put a stranger's work in somebody's profile.
 */
export function personInsight(
  person: Person,
  prs: CensusPr[],
  reviews: CensusReview[],
  reviewPrecision: Precision,
  now: Date,
): PersonInsight {
  const mine = new Set(person.aliases.map((a) => identityKey(a.provider, a.username)));
  const isMine = (provider: Provider, username: string) =>
    username !== "" && mine.has(identityKey(provider, username));

  // `ReviewerStat` is keyed by a single identity, but these counts span every
  // alias. The primary alias stands for the person; `label` is the display name.
  // Shared by both stats so the two can never disagree on whose they are.
  const primary = person.aliases[0];
  const emptyStat = (): ReviewerStat => ({
    provider: primary?.provider ?? "github",
    username: primary?.username ?? "",
    approved: 0,
    changesRequested: 0,
    commented: 0,
    total: 0,
  });

  // Two indexes over one pass. `authored` drives every authorship figure;
  // `byKey` exists so a review act can find the pull request it landed on
  // without rescanning thousands of rows per act.
  const authored: CensusPr[] = [];
  const authoredKeys = new Set<string>();
  const byKey = new Map<string, CensusPr>();
  for (const pr of prs) {
    byKey.set(prKey(pr), pr);
    if (!isMine(pr.provider, pr.author)) continue;
    authored.push(pr);
    authoredKeys.add(prKey(pr));
  }

  const counts = countStates(authored);
  const mergeHours: number[] = [];
  const tally = new Map<string, MonthTally>();
  const repos = new Map<string, PersonInsight["repos"][number]>();

  let additions = 0;
  let deletions = 0;
  let files = 0;
  let selfMerged = 0;
  let firstSeen: string | null = null;
  let lastSeen: string | null = null;

  const sawFirst = (at: string | null) => {
    if (at !== null && (firstSeen === null || at < firstSeen)) firstSeen = at;
  };
  const sawLast = (at: string | null) => {
    if (at !== null && (lastSeen === null || at > lastSeen)) lastSeen = at;
  };
  for (const pr of authored) {
    additions += pr.additions;
    deletions += pr.deletions;
    files += pr.files;

    tallyInto(tally, monthKey(pr.createdAt), "opened");
    sawFirst(pr.createdAt);
    sawLast(pr.updatedAt);

    if (pr.state === "merged") {
      tallyInto(tally, monthKey(pr.mergedAt), "merged");
      const hours = hoursBetween(pr.createdAt, pr.mergedAt);
      if (hours !== null) mergeHours.push(hours);
      if (pr.mergedBy !== "" && isMine(pr.provider, pr.mergedBy)) selfMerged++;
    }

    const entry = repoEntry(repos, pr.provider, pr.repo);
    entry.opened++;
    if (pr.state === "merged") entry.merged++;
    else if (pr.state === "closed") entry.closed++;
    entry.additions += pr.additions;
    entry.deletions += pr.deletions;
  }

  const reviewsGiven = emptyStat();
  const reviewsReceived = emptyStat();
  const latency: number[] = [];

  for (const review of reviews) {
    if (isMine(review.provider, review.reviewer)) {
      addAct(reviewsGiven, review.act);
      tallyInto(tally, monthKey(review.at), "reviews");
      sawFirst(review.at);
      sawLast(review.at);
      // Reviewing is working on a project. Counted here so a project somebody
      // only reviews in still appears, which is the whole profile for a
      // reviewer-only identity.
      repoEntry(repos, review.provider, review.repo).reviews++;

      // Latency is measured against the pull request the act landed on, which
      // is usually somebody else's — hence the index over every row, not just
      // the authored ones.
      const hours = hoursBetween(byKey.get(prKey(review))?.createdAt ?? null, review.at);
      if (hours !== null) latency.push(hours);
      continue;
    }
    // Received: acts on this person's pull requests, by anybody else. Their own
    // acts on their own PR are already counted as given, and counting them here
    // would report a person as having reviewed themselves into approval.
    if (authoredKeys.has(prKey(review))) addAct(reviewsReceived, review.act);
  }

  return {
    id: person.id,
    label: person.label,
    aliases: person.aliases.map((a) => ({ provider: a.provider, username: a.username })),
    counts,
    medianHoursToMerge: median(mergeHours),
    mergeRate: mergeRateOf(counts),
    additions,
    deletions,
    files,
    repos: [...repos.values()].sort(
      (a, b) =>
        b.opened - a.opened ||
        b.merged - a.merged ||
        b.reviews - a.reviews ||
        asc(a.repo, b.repo) ||
        asc(a.provider, b.provider),
    ),
    reviewsGiven,
    reviewsReceived,
    // GitLab hands over review acts with no timestamp at all, so a latency here
    // could only be invented. Withheld rather than guessed.
    medianReviewLatencyHours: reviewPrecision === "approximate" ? null : median(latency),
    reviewPrecision,
    activity: monthSeries(tally, now).map((entry) => ({
      month: entry.month,
      opened: entry.row.opened,
      merged: entry.row.merged,
      reviews: entry.row.reviews,
    })),
    firstSeen,
    lastSeen,
    selfMerged,
  };
}

/** One row per project, created on first sight from either direction. */
function repoEntry(
  repos: Map<string, PersonInsight["repos"][number]>,
  provider: Provider,
  repo: string,
): PersonInsight["repos"][number] {
  const key = `${provider}:${repo}`;
  let entry = repos.get(key);
  if (entry === undefined) {
    entry = {
      provider,
      repo,
      opened: 0,
      merged: 0,
      closed: 0,
      additions: 0,
      deletions: 0,
      reviews: 0,
    };
    repos.set(key, entry);
  }
  return entry;
}


/**
 * State counts per project. The repo list page needs nothing else, and running
 * a full `repoInsight` per project to render one row would sort and quantile
 * thousands of rows for numbers nobody asked for.
 */
export function repoTotals(prs: CensusPr[]): Map<string, StateCounts> {
  const totals = new Map<string, StateCounts>();
  for (const pr of prs) {
    const key = `${pr.provider}:${pr.repo}`;
    let row = totals.get(key);
    if (row === undefined) {
      row = { open: 0, merged: 0, closed: 0, total: 0 };
      totals.set(key, row);
    }
    row[pr.state]++;
    row.total++;
  }
  return totals;
}
