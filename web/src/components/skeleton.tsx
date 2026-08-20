/**
 * What a navigation looks like while its loader runs.
 *
 * Measured before this existed: zero elements matching `[aria-busy]`,
 * `[role="status"]` or `.animate-pulse` anywhere in the app. Every route loader
 * blocks the navigation, so clicking a person left the previous page on screen
 * and then swapped it — nothing said a click had registered, and on a cold
 * SQLite read that silence lasts long enough to click again.
 *
 * One skeleton for four routes rather than one per page, because it is wired at
 * the router (`defaultPendingComponent`) where the pending state actually is.
 * The three list pages share a shape — summary header, sticky column strip, then
 * fixed-height rows — so the placeholder is that shape with its text removed.
 *
 * The heights are pinned to what the real pages measure, not eyeballed, so the
 * column strip and the first row sit where the real ones will and nothing jumps
 * when the loader returns:
 *   - summary header 50.5px on /repos and /people, 45px on /settings -> 3.15rem
 *   - sticky column strip 32.5px on all three -> 2.03rem
 *   - one row 24px on all three -> h-6, with `px-4` matching the row padding
 */

/**
 * Twelve rows: enough to read as a table on a 900px viewport, few enough that
 * the pulse stays one gesture rather than a wall of movement.
 */
const ROWS = Array.from({ length: 12 }, (_, i) => i);

/** The pulsing bar every placeholder cell is made of. */
function Bar({ className }: { className: string }) {
  return <span className={`block h-3 animate-pulse rounded bg-surface-raised ${className}`} />;
}

export function TableSkeleton() {
  return (
    /*
     * `role="status"` with `aria-busy` rather than a visually-hidden "loading"
     * sentence: the region announces itself once, politely, and the bars carry
     * no text a screen reader would have to wade through. `aria-hidden` on the
     * bars would be redundant — they hold nothing to read.
     */
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading table"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex h-[3.15rem] shrink-0 items-center border-b border-border-muted bg-surface px-4">
        <Bar className="w-64" />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-[2.03rem] items-center gap-3 border-b border-border-muted bg-surface px-4">
          <Bar className="w-24" />
          <Bar className="ml-auto w-10" />
          <Bar className="w-10" />
          <Bar className="w-10" />
          <Bar className="w-10" />
        </div>

        {ROWS.map((i) => (
          <div
            key={i}
            className="flex h-6 items-center gap-3 border-b border-border-muted px-4"
          >
            <Bar className="w-6" />
            {/* Widths alternate so the block reads as rows of differing content
                rather than a grid, which is what the real list looks like. */}
            <Bar className={i % 3 === 0 ? "w-1/3" : i % 3 === 1 ? "w-1/4" : "w-2/5"} />
            <Bar className="ml-auto w-10" />
            <Bar className="w-10" />
            <Bar className="w-10" />
            <Bar className="w-10" />
          </div>
        ))}
      </div>
    </div>
  );
}
