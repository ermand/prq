#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "tickets");

const tickets = readdirSync(dir)
  .filter((f) => f.endsWith(".md"))
  .map((file) => {
    const raw = readFileSync(join(dir, file), "utf8");
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) throw new Error(`${file}: missing frontmatter`);
    const t = { file };
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      t[k] =
        k === "blocked_by"
          ? (v.match(/\d+/g) ?? [])
          : v.replace(/^["']|["']$/g, "");
    }
    return t;
  })
  .sort((a, b) => a.id.localeCompare(b.id));

const closed = new Set(tickets.filter((t) => t.status === "closed").map((t) => t.id));
const open = tickets.filter((t) => t.status !== "closed");
const unblocked = (t) => t.blocked_by.every((id) => closed.has(id));

const show = (t) => {
  const blockers = t.blocked_by.filter((id) => !closed.has(id));
  const on = blockers.length ? `  ← blocked on ${blockers.join(", ")}` : "";
  const by = t.assignee && t.assignee !== "~" ? `  [claimed: ${t.assignee}]` : "";
  return `  ${t.id}  ${t.title}  (${t.type})${on}${by}`;
};

const frontier = open.filter((t) => unblocked(t) && (!t.assignee || t.assignee === "~"));
const claimed = open.filter((t) => unblocked(t) && t.assignee && t.assignee !== "~");
const blocked = open.filter((t) => !unblocked(t));

console.log(`FRONTIER (${frontier.length})`);
frontier.forEach((t) => console.log(show(t)));
if (claimed.length) {
  console.log(`\nCLAIMED (${claimed.length})`);
  claimed.forEach((t) => console.log(show(t)));
}
console.log(`\nBLOCKED (${blocked.length})`);
blocked.forEach((t) => console.log(show(t)));
console.log(`\nCLOSED (${closed.size})`);
tickets.filter((t) => t.status === "closed").forEach((t) => console.log(show(t)));
