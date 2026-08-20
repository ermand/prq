/**
 * A throwaway control for choosing between throwaway layouts.
 *
 * It is loud on purpose. The thing being judged is the page behind it, and a
 * tasteful switcher in the page's own palette would be read as part of the
 * design — so this is fuchsia, ringed, and floats over the content where no
 * real control in this tool ever sits. When a variant wins, this file and the
 * `variant` search param are deleted together.
 *
 * `import.meta.env.DEV` gates the whole thing. The param survives in the URL
 * either way, but a stray merge cannot ship the bar to anybody.
 *
 * The two ends are real `Link`s rather than buttons: the choice lives in the
 * URL, so it is shareable and survives a reload, and cmd-click opens the other
 * layout beside this one for comparison — which is the entire point of having
 * three. The arrow keys are a convenience over the same navigation, and they
 * stand down while a text field has focus, or holding ArrowLeft in the project
 * filter would walk the layouts instead of the caret.
 */

import { Link, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import type { Variant } from "../routes/repos";

/** True while a keystroke belongs to whatever the user is typing into. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    target.isContentEditable ||
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT"
  );
}

export function VariantBar({
  variants,
  current,
  names,
}: {
  variants: readonly Variant[];
  current: Variant;
  names: Record<Variant, string>;
}) {
  const router = useRouter();

  const at = Math.max(0, variants.indexOf(current));
  // Wraps both ways: three layouts compared by tapping one key should never
  // dead-end at an edge.
  const step = (delta: number): Variant =>
    variants[(at + delta + variants.length) % variants.length] ?? current;

  const prev = step(-1);
  const next = step(1);

  useEffect(() => {
    if (!import.meta.env.DEV) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      // A modified arrow is a word jump or a browser gesture, not a request.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target) || isTyping(document.activeElement)) return;

      event.preventDefault();
      void router.navigate({
        to: "/repos",
        search: (old) => ({ ...old, variant: event.key === "ArrowLeft" ? prev : next }),
        replace: true,
        resetScroll: false,
      });
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, prev, next]);

  if (!import.meta.env.DEV) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-fuchsia-700 p-1 text-white shadow-lg ring-2 ring-fuchsia-300/70">
        <Arrow to={prev} label={`Previous layout — ${names[prev]}`} glyph="←" />

        <span className="px-2 font-mono text-2xs whitespace-nowrap select-none">
          {names[current]}
          <span className="ml-2 text-fuchsia-200">
            {at + 1}/{variants.length}
          </span>
        </span>

        <Arrow to={next} label={`Next layout — ${names[next]}`} glyph="→" />
      </div>
    </div>
  );
}

function Arrow({
  to,
  label,
  glyph,
}: {
  to: Variant;
  label: string;
  glyph: string;
}) {
  return (
    <Link
      to="/repos"
      // Only `variant` moves. The selected project and the filter are somebody
      // else's state and must survive the comparison.
      search={(old) => ({ ...old, variant: to })}
      replace
      resetScroll={false}
      title={label}
      aria-label={label}
      className="rounded-full px-2 py-0.5 text-2xs leading-none hover:bg-fuchsia-500 focus-visible:bg-fuchsia-500"
    >
      <span aria-hidden="true">{glyph}</span>
    </Link>
  );
}
