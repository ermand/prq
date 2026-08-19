#!/usr/bin/env bun
/**
 * Headless scan — the smoke test and the `--json` escape hatch.
 *
 * Usage: bun src/scan-cli.ts owner/repo [owner/repo ...]
 */

import { groupIntoBuckets } from "./domain";
import { githubToken, scan } from "./github";

const repos = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const asJson = process.argv.includes("--json");

if (repos.length === 0) {
  process.stderr.write("usage: scan-cli owner/repo [owner/repo ...] [--json]\n");
  process.exit(2);
}

const started = Date.now();
const result = await scan(repos, await githubToken());
const elapsed = ((Date.now() - started) / 1000).toFixed(2);

if (asJson) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

const lines: string[] = [
  `viewer ${result.viewer} · ${result.prs.length} PRs · ${repos.length} repos · cost ${result.cost} · ${elapsed}s`,
];
for (const failure of result.failures) lines.push(`  INCOMPLETE — ${failure}`);

for (const bucket of groupIntoBuckets(result.prs)) {
  lines.push("", `${bucket.label} (${bucket.items.length})`);
  for (const pr of bucket.items) {
    const stack = pr.stacks.map((s) => ` [stack ${s.position}/${s.size}]`).join("");
    const flags = [
      pr.draft ? "draft" : "",
      pr.checks === "failing" ? "ci-red" : "",
      pr.merge === "conflicted" ? "conflict" : "",
      // `null` is "the provider cannot tell", which is not the same as "it did not
      // move" — and the row still sits in the bucket that assumes it might have.
      pr.staleBlock === null
        ? "may-have-moved"
        : pr.staleBlock.value
          ? "moved-since-my-block"
          : "",
    ].filter(Boolean);
    lines.push(
      `  ${pr.repo}#${pr.number} ${pr.title.slice(0, 60)}` +
        ` — ${pr.verdict}/${pr.standing}${stack}` +
        (flags.length ? ` (${flags.join(", ")})` : ""),
    );
  }
}

process.stdout.write(`${lines.join("\n")}\n`);
