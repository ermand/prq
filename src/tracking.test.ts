import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { Store } from "./store";
import { openTracking } from "./tracking";

const AT = new Date("2026-08-20T12:00:00.000Z");
const paths: string[] = [];

async function store(): Promise<Store> {
  const path = join(
    import.meta.dir,
    "..",
    "node_modules",
    `.prq-tracking-${paths.length}-${Bun.nanoseconds()}.db`,
  );
  paths.push(path);
  return await Store.open(path);
}

afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  }
});

const config = (over: Partial<Config> = {}): Config => ({
  projects: { github: ["owner/one", "owner/two"], gitlab: ["group/sub/three"] },
  people: [
    {
      label: "Ermand Durro",
      aliases: [
        { provider: "github", username: "ermand" },
        { provider: "gitlab", username: "ermandduro" },
      ],
    },
  ],
  ...over,
});

describe("openTracking", () => {
  test("imports the config into a fresh database, once", async () => {
    const s = await store();
    const first = openTracking(s, config(), AT);

    expect(first.projects).toEqual({
      github: ["owner/one", "owner/two"],
      gitlab: ["group/sub/three"],
    });
    expect(first.people).toHaveLength(1);
    expect(first.people[0]?.id).toBe("ermand-durro");
    expect(first.notices.join(" ")).toMatch(/imported 3 project\(s\) and 1 identity rule/);
    s.close();
  });

  test("deleting every project does not bring the config back", async () => {
    // The rule the prototype was built to test. With "import when the table is
    // empty" instead of a recorded marker, removing your last project resurrects
    // the whole config on the next launch.
    const s = await store();
    openTracking(s, config(), AT);
    for (const project of s.projects()) s.removeProject(project.provider, project.path);
    expect(s.projects()).toHaveLength(0);

    const relaunch = openTracking(s, config(), AT);

    expect(relaunch.projects).toEqual({ github: [], gitlab: [] });
    expect(s.projects()).toHaveLength(0);
    s.close();
  });

  test("a stale config is reported rather than silently ignored", async () => {
    const s = await store();
    openTracking(s, config(), AT);
    const second = openTracking(s, config(), AT);
    // Loud on every run: a file that looks authoritative, is edited, and changes
    // nothing is worse than a repeated notice.
    expect(second.notices.join(" ")).toMatch(/no longer read/);
    s.close();
  });

  test("edits made after seeding win over the config", async () => {
    const s = await store();
    openTracking(s, config(), AT);
    s.removeProject("github", "owner/one");
    s.addProject("github", "owner/added", AT);

    const after = openTracking(s, config(), AT);

    expect(after.projects.github).toEqual(["owner/added", "owner/two"]);
    s.close();
  });

  test("an empty config on a fresh database seeds nothing and says nothing", async () => {
    // What `prq init` now writes. Silence is right here: the CLI reports "no
    // projects tracked" separately, because the fix is a command not a file.
    const s = await store();
    const tracking = openTracking(
      s,
      config({ projects: { github: [], gitlab: [] }, people: [] }),
      AT,
    );

    expect(tracking.projects).toEqual({ github: [], gitlab: [] });
    expect(tracking.notices).toEqual([]);
    expect(s.isSeeded()).toBe(true);
    s.close();
  });

  test("a renamed person survives a relaunch and keeps their id", async () => {
    // The id is what the URLs point at, so it must not follow the label.
    const s = await store();
    openTracking(s, config(), AT);
    s.renamePerson("gitlab:kaziu", "Kristi Aziu", AT);

    const after = openTracking(s, config(), AT);
    const kristi = after.people.find((p) => p.id === "gitlab:kaziu");

    expect(kristi?.label).toBe("Kristi Aziu");
    expect(kristi?.aliases).toEqual([{ provider: "gitlab", username: "kaziu" }]);
    s.close();
  });
});
