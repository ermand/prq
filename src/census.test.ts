import { describe, expect, test } from "bun:test";
import {
  identityKey,
  isBot,
  isCensusPr,
  resolvePeople,
  slug,
  toCount,
  toPrState,
  toReviewAct,
  toTime,
  type CensusPr,
} from "./census";

describe("isBot", () => {
  test("catches the two machines actually in the store", () => {
    // Both measured: dependabot 126 pull requests, gemini-code-assist 549
    // review acts. Either one ranked among the staff makes the roster a lie.
    expect(isBot("dependabot")).toBe(true);
    expect(isBot("gemini-code-assist")).toBe(true);
  });

  test("catches the conventional suffixes whatever the case", () => {
    expect(isBot("renovate[bot]")).toBe(true);
    expect(isBot("Dependabot[BOT]")).toBe(true);
    expect(isBot("release-bot")).toBe(true);
    expect(isBot("CODECOV")).toBe(true);
  });

  test("leaves every real contributor alone", () => {
    // Straight from the store, including the awkward ones: a dotted GitLab
    // login, a hyphenated GitHub login, and a name ending in a digit.
    for (const human of [
      "ermand",
      "ermandduro",
      "dionverushi",
      "luisalla-art",
      "maksimiliano.bajo",
      "armela.ligori",
      "jcelmeta14",
      "bbregu141",
      "GledisSelfaj",
      "mhysollari",
    ]) {
      expect(isBot(human)).toBe(false);
    }
  });

  test("does not classify by behaviour", () => {
    // `mhysollari` authored nothing and reviewed three times, exactly the shape
    // of an AI reviewer. A behavioural heuristic would reclassify a person.
    expect(isBot("mhysollari")).toBe(false);
  });
});

describe("resolvePeople", () => {
  const identities = [
    { provider: "github" as const, username: "ermand" },
    { provider: "gitlab" as const, username: "ermandduro" },
    { provider: "github" as const, username: "dionverushi" },
  ];

  test("merges the configured aliases into one person", () => {
    const { people, of } = resolvePeople(identities, [
      {
        label: "Ermand Durro",
        aliases: [
          { provider: "github", username: "ermand" },
          { provider: "gitlab", username: "ermandduro" },
        ],
      },
    ]);

    expect(of.get("github:ermand")).toBe("ermand-durro");
    expect(of.get("gitlab:ermandduro")).toBe("ermand-durro");
    // The unclaimed identity still gets a profile, under its forge login.
    expect(of.get("github:dionverushi")).toBe("github:dionverushi");
    expect(people).toHaveLength(2);
  });

  test("every identity stands alone with no rules at all", () => {
    const { people, of } = resolvePeople(identities, []);
    expect(people).toHaveLength(3);
    expect(of.get("github:ermand")).toBe("github:ermand");
    expect(of.get("gitlab:ermandduro")).toBe("gitlab:ermandduro");
  });

  test("two people sharing a label keep separate profiles", () => {
    const { people } = resolvePeople([], [
      { label: "Alex Smith", aliases: [{ provider: "github", username: "alex1" }] },
      { label: "Alex Smith", aliases: [{ provider: "github", username: "alex2" }] },
    ]);
    // Colliding slugs would merge two humans into one profile, which is worse
    // than an ugly id.
    expect(new Set(people.map((p) => p.id)).size).toBe(2);
  });

  test("the empty login is never given a person", () => {
    // The trust boundary turns a hidden or deleted account into "", and one
    // phantom profile would pool every such row together.
    const { people, of } = resolvePeople([{ provider: "github", username: "" }], []);
    expect(people).toHaveLength(0);
    expect(of.get("github:")).toBeUndefined();
  });

  test("a claimed identity that never appears still yields a person", () => {
    // Somebody configured before their first pull request lands should not
    // vanish from the roster.
    const { people } = resolvePeople([], [
      { label: "New Hire", aliases: [{ provider: "github", username: "newhire" }] },
    ]);
    expect(people.map((p) => p.id)).toEqual(["new-hire"]);
  });
});

describe("slug", () => {
  test("survives punctuation, case and spacing", () => {
    expect(slug("Ermand Durro")).toBe("ermand-durro");
    expect(slug("  O'Brien,  Seán  ")).toBe("o-brien-se-n");
  });

  test("never returns an empty id", () => {
    // An empty id would collide with every other empty id.
    expect(slug("—")).toBe("person");
    expect(slug("")).toBe("person");
  });
});

describe("trust boundary", () => {
  test("maps both forges' state spellings", () => {
    expect(toPrState("MERGED")).toBe("merged");
    expect(toPrState("merged")).toBe("merged");
    expect(toPrState("LOCKED")).toBe("closed");
    expect(toPrState("opened")).toBe("open");
  });

  test("an unknown state is not treated as open", () => {
    // Open means "still needs attention". Guessing that would invent work.
    expect(toPrState("SOMETHING_NEW")).toBe("closed");
    expect(toPrState(null)).toBe("closed");
  });

  test("only real acts count as review acts", () => {
    expect(toReviewAct("APPROVED")).toBe("approved");
    expect(toReviewAct("REQUESTED_CHANGES")).toBe("changes-requested");
    expect(toReviewAct("CHANGES_REQUESTED")).toBe("changes-requested");
    expect(toReviewAct("REVIEWED")).toBe("commented");
    // An unsubmitted draft review and an untouched reviewer are not opinions.
    expect(toReviewAct("PENDING")).toBeNull();
    expect(toReviewAct("UNREVIEWED")).toBeNull();
    expect(toReviewAct(undefined)).toBeNull();
  });

  test("counts refuse rubbish rather than propagating it", () => {
    expect(toCount(42)).toBe(42);
    expect(toCount(-1)).toBe(0);
    expect(toCount(Number.NaN)).toBe(0);
    expect(toCount("7")).toBe(0);
    expect(toCount(3.7)).toBe(3);
  });

  test("times are canonical UTC or null", () => {
    expect(toTime("2026-08-20T12:00:00+02:00")).toBe("2026-08-20T10:00:00.000Z");
    expect(toTime("")).toBeNull();
    expect(toTime(null)).toBeNull();
  });
});

describe("isCensusPr", () => {
  const row: CensusPr = {
    provider: "github",
    repo: "nebulaltd/pok-auctions",
    number: 22,
    state: "merged",
    draft: false,
    title: "Add account activity",
    url: "https://github.com/nebulaltd/pok-auctions/pull/22",
    author: "ermand",
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T11:00:00.000Z",
    mergedAt: "2026-08-20T11:00:00.000Z",
    closedAt: null,
    additions: 7,
    deletions: 32,
    files: 2,
    mergedBy: "ElsiPotka",
  };

  test("accepts a stored row", () => {
    expect(isCensusPr(row)).toBe(true);
    expect(isCensusPr({ ...row, url: null })).toBe(true);
  });

  test("rejects a row that would put a non-https link on screen", () => {
    expect(isCensusPr({ ...row, url: "javascript:alert(1)" })).toBe(false);
  });

  test("rejects structurally wrong rows", () => {
    expect(isCensusPr({ ...row, provider: "bitbucket" })).toBe(false);
    expect(isCensusPr({ ...row, state: "reopened" })).toBe(false);
    expect(isCensusPr({ ...row, number: "22" })).toBe(false);
    expect(isCensusPr(null)).toBe(false);
  });
});

describe("identityKey", () => {
  test("namespaces by provider", () => {
    // `ermand` on GitHub and a different `ermand` on GitLab must never collide.
    expect(identityKey("github", "ermand")).not.toBe(identityKey("gitlab", "ermand"));
  });
});
