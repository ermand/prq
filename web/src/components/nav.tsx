/**
 * The one navigation bar.
 *
 * Deliberately thin, and deliberately not merged into each page's own header.
 * Merging would mean every page injecting controls into a shared bar through
 * context or a portal, which costs more than the ~30px it saves — and vertical
 * space on this board is real, so the strip carries links and nothing else.
 */

import { Link } from "@tanstack/react-router";

const TABS = [
  { to: "/", label: "Board", hint: "open pull requests that concern you" },
  { to: "/repos", label: "Projects", hint: "every project, from stored history" },
  { to: "/people", label: "People", hint: "contribution profiles" },
  { to: "/settings", label: "Settings", hint: "which projects prq tracks" },
] as const;

export function Nav() {
  return (
    <nav className="flex shrink-0 items-center gap-4 border-b border-border-muted bg-canvas px-4 py-1.5">
      <span className="font-mono text-title text-fg">prq</span>
      <ul className="flex items-center gap-1">
        {TABS.map((tab) => (
          <li key={tab.to}>
            <Link
              to={tab.to}
              title={tab.hint}
              // `exact` on the board only: every other route would otherwise
              // stay unhighlighted, since `/` is a prefix of all of them.
              activeOptions={{ exact: tab.to === "/" }}
              activeProps={{
                className: "rounded px-2 py-0.5 text-chip bg-surface-raised text-fg",
              }}
              inactiveProps={{
                className:
                  "rounded px-2 py-0.5 text-chip text-fg-muted hover:bg-surface hover:text-fg",
              }}
            >
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
