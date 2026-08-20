/**
 * The census: repo-wide, all-state history.
 *
 * A *scan* (`src/providers.ts`) answers "what needs me right now" — it is
 * ego-scoped (`involves:@me`) and open-only (`is:open`), and its rows are
 * replaced wholesale on every sync. That shape cannot answer "how many PRs does
 * this repo have" or "who contributes to it", because it has never seen a merged
 * PR or a PR belonging to somebody else.
 *
 * A *census* is the other axis: every pull request in a configured project,
 * whatever its state and whoever opened it, kept durably. Measured on this
 * machine, the configured projects hold 5384 pull and merge requests (4819
 * GitHub, 565 GitLab) — 55 pages, about 55 rate-limit points of 5000, roughly
 * six minutes. That cost is why a census is its own explicit command and never
 * rides along with a sync.
 *
 * The two never share a table. A sync must stay fast and destructive; a census
 * is slow and accumulative.
 */

import { canonicalTime, sanitize, safeUrl, type Precision, type Provider } from "./domain";

/**
 * Where a pull request ended up. Deliberately three values: GitHub distinguishes
 * MERGED from CLOSED, GitLab distinguishes merged from closed and locked, and
 * "closed without merging" is the interesting signal both share.
 */
export type PrState = "open" | "merged" | "closed";

/**
 * What a reviewer did. `dismissed` is kept separate from `commented` because a
 * dismissed approval is not an opinion any more, and counting it as one would
 * inflate a reviewer's approval rate.
 */
export type ReviewAct = "approved" | "changes-requested" | "commented" | "dismissed";

/** One pull or merge request, as the census stores it. */
export interface CensusPr {
  provider: Provider;
  /** Provider-native path. `owner/name` on GitHub, any depth on GitLab. */
  repo: string;
  number: number;
  state: PrState;
  draft: boolean;
  title: string;
  /** Validated https URL, or null when the API handed us something else. */
  url: string | null;
  /** Empty when the API hid the account — deleted users really do appear. */
  author: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  additions: number;
  deletions: number;
  files: number;
  /** Who pressed merge. Empty unless merged, and empty when the API hid them. */
  mergedBy: string;
}

/**
 * One review act. Not keyed: the same reviewer can act repeatedly on one pull
 * request, and the sequence is the interesting part.
 */
export interface CensusReview {
  provider: Provider;
  repo: string;
  number: number;
  reviewer: string;
  act: ReviewAct;
  /**
   * Null on GitLab. `approvedBy` and `reviewers` carry no timestamp, so review
   * latency is computable on GitHub and merely unknown on GitLab — the same
   * asymmetry `StaleBlock.precision` already records for the board.
   */
  at: string | null;
}

/** One project's census, whole or refused. */
export interface RepoCensus {
  provider: Provider;
  repo: string;
  prs: CensusPr[];
  reviews: CensusReview[];
  /**
   * How complete the review side is. `approximate` means review acts are
   * present but unattributable in time, so anything latency-shaped must be
   * withheld rather than guessed.
   */
  reviewPrecision: Precision;
  /** Set when the project could not be read. Rows are then not to be trusted. */
  failed: string | null;
  /** True when paging hit its ceiling, so `prs` is a prefix and not the whole. */
  truncated: boolean;
}

/** One provider's census operation. Mirrors `ProviderClient` in providers.ts. */
export interface CensusClient {
  /**
   * Reads one project completely. `since` bounds the walk: pages arrive newest
   * first, so a caller that already holds older rows can stop early. Full
   * history when null.
   */
  censusRepo(repo: string, since: string | null, signal?: AbortSignal): Promise<RepoCensus>;
}

/**
 * Paging ceiling, in pages of 100. The largest configured repo is 3309 pull
 * requests — 34 pages — so 200 leaves two orders of magnitude of headroom while
 * still bounding a runaway cursor. Hitting it sets `truncated` rather than
 * silently returning a prefix, the same refusal the scan makes.
 */
export const MAX_PAGES = 200;

export const PAGE_SIZE = 100;

/**
 * How many review nodes to pull per pull request. Measured: 100 pull requests
 * carried 117 reviews between them, so 50 is far past the real distribution.
 */
export const REVIEW_PAGE = 50;

export function toPrState(raw: string | null | undefined): PrState {
  switch ((raw ?? "").toUpperCase()) {
    case "MERGED":
      return "merged";
    case "CLOSED":
    case "LOCKED":
      return "closed";
    case "OPEN":
    case "OPENED":
      return "open";
    default:
      // An unknown state is not evidence of an open pull request. Treating it as
      // closed keeps it out of the "still needs attention" counts.
      return "closed";
  }
}

export function toReviewAct(raw: string | null | undefined): ReviewAct | null {
  switch ((raw ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
    case "REQUESTED_CHANGES":
      return "changes-requested";
    case "COMMENTED":
    case "REVIEWED":
      return "commented";
    case "DISMISSED":
      return "dismissed";
    default:
      // PENDING on GitHub is an unsubmitted draft review, and UNREVIEWED /
      // UNAPPROVED on GitLab mean nothing happened yet. None of them is an act.
      return null;
  }
}

/** A login, through the same trust boundary every remote string crosses. */
export function toLogin(raw: unknown): string {
  return typeof raw === "string" ? sanitize(raw) : "";
}

/** Non-negative integer, or zero. Diff stats are absent on some GitLab rows. */
export function toCount(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export function toTime(raw: unknown): string | null {
  return typeof raw === "string" && raw !== "" ? canonicalTime(raw) : null;
}

/**
 * A human. One person can hold an identity on each forge — the driver is
 * `ermand` on GitHub and `ermandduro` on GitLab — and a performance profile
 * that splits them in half is not merely incomplete, it is wrong. Aliases come
 * from the `people:` block in config; every identity nobody claimed becomes its
 * own person.
 */
export interface Person {
  /** Stable slug. `${provider}:${username}` for an unclaimed identity. */
  id: string;
  label: string;
  aliases: { provider: Provider; username: string }[];
}

/**
 * Whether a login is a machine.
 *
 * Measured on this machine: `dependabot` sits fifth by pull requests with 126,
 * and `gemini-code-assist` third by total activity with 549 review acts and
 * zero pull requests. A profile page that ranks either among the staff is not a
 * small inaccuracy, so bots are identified and separated rather than filtered
 * silently — the count stays visible, it just stops competing with people.
 *
 * Pattern-based because neither API marks this reliably: GitHub's `__typename`
 * distinguishes Bot from User but only for apps installed on the repository, and
 * a plain account named `ci-deploy` is invisible to it.
 *
 * Deliberately *not* inferred from behaviour. "Reviews a lot and authors
 * nothing" describes `gemini-code-assist`, and it equally describes a tech lead
 * — `mhysollari` has 0 pull requests and 3 reviews. A heuristic there would
 * quietly reclassify people, so an unknown bot stays listed as a person until
 * its name is added here.
 */
export function isBot(username: string): boolean {
  const name = username.toLowerCase();
  return (
    name.endsWith("[bot]") ||
    name.endsWith("-bot") ||
    name.endsWith("-code-assist") ||
    BOTS[name] === true
  );
}

/** Named machines seen in the wild, or common enough to expect. */
const BOTS: Record<string, true> = {
  dependabot: true,
  renovate: true,
  "github-actions": true,
  codecov: true,
  snyk: true,
  imgbot: true,
  "semantic-release": true,
  copilot: true,
  coderabbitai: true,
  sonarcloud: true,
  sourcery: true,
  deepsource: true,
  greptile: true,
};

/** The `people:` block, after parsing. */
export interface PersonRule {
  label: string;
  aliases: { provider: Provider; username: string }[];
}

export function slug(label: string): string {
  return (
    sanitize(label)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "person"
  );
}

export function identityKey(provider: Provider, username: string): string {
  return `${provider}:${username}`;
}

/**
 * Resolves every seen identity onto a person. Configured rules win; anything
 * left over stands alone under its forge login, so a project with no `people:`
 * block still gets a complete, if unmerged, set of profiles.
 */
export function resolvePeople(
  identities: { provider: Provider; username: string }[],
  rules: PersonRule[],
): { people: Person[]; of: Map<string, string> } {
  const of = new Map<string, string>();
  const people: Person[] = [];
  const taken = new Set<string>();

  for (const rule of rules) {
    let id = slug(rule.label);
    // Two people can share a label — or a slug. Keep ids unique rather than
    // silently merging two humans into one profile.
    for (let n = 2; taken.has(id); n++) id = `${slug(rule.label)}-${n}`;
    taken.add(id);
    people.push({ id, label: rule.label, aliases: rule.aliases });
    for (const alias of rule.aliases) of.set(identityKey(alias.provider, alias.username), id);
  }

  for (const identity of identities) {
    const key = identityKey(identity.provider, identity.username);
    if (identity.username === "" || of.has(key)) continue;
    of.set(key, key);
    people.push({ id: key, label: identity.username, aliases: [identity] });
  }

  return { people, of };
}

/** Guards a census row read back out of storage. */
export function isCensusPr(value: unknown): value is CensusPr {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    (row.provider === "github" || row.provider === "gitlab") &&
    typeof row.repo === "string" &&
    typeof row.number === "number" &&
    (row.state === "open" || row.state === "merged" || row.state === "closed") &&
    typeof row.author === "string" &&
    typeof row.createdAt === "string" &&
    (row.url === null || safeUrl(row.url) !== null)
  );
}
