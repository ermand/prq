/**
 * The two charts this tool needs, in SVG, with no dependency.
 *
 * A charting library would be the larger part of the bundle for two shapes, and
 * both are read-only pictures of arrays the server already computed. `insights`
 * emits complete month series including empty months, so a gap here is a real
 * quiet month rather than a compressed axis — which is exactly why these draw
 * every bucket, including the zero ones.
 */

export interface MonthPoint {
  month: string;
  a: number;
  b: number;
}

/**
 * Paired monthly bars. `a` sits behind `b` rather than beside it: opened and
 * merged are not independent quantities, and the gap between them at a glance is
 * the backlog. Side-by-side bars at 56 months would be two pixels each.
 */
export function MonthBars({
  points,
  labelA,
  labelB,
  height = 64,
}: {
  points: MonthPoint[];
  labelA: string;
  labelB: string;
  height?: number;
}) {
  if (points.length === 0) {
    return <p className="text-body text-fg-subtle">No activity recorded.</p>;
  }
  const peak = Math.max(1, ...points.map((p) => Math.max(p.a, p.b)));
  // Trailing window: 56 months of history at 4px a bar is wider than any panel,
  // and the recent end is the part anybody reads.
  const shown = points.slice(-36);

  return (
    <div>
      <div className="flex items-center gap-3 text-meta text-fg-muted">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-fg-subtle" />
          {labelA}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-accent" />
          {labelB}
        </span>
        <span className="ml-auto font-mono">peak {peak}</span>
      </div>
      <div
        className="mt-1.5 flex items-end gap-px"
        style={{ height: `${height}px` }}
        role="img"
        aria-label={`${labelA} and ${labelB} by month`}
      >
        {shown.map((point) => (
          <div
            key={point.month}
            className="group relative flex-1"
            style={{ height: "100%" }}
            title={`${point.month} — ${labelA} ${point.a}, ${labelB} ${point.b}`}
          >
            <div className="absolute inset-x-0 bottom-0 flex flex-col justify-end">
              <div
                className="w-full rounded-t-sm bg-fg-subtle group-hover:bg-fg-muted"
                style={{ height: `${(point.a / peak) * height}px` }}
              />
            </div>
            <div className="absolute inset-x-0 bottom-0 flex flex-col justify-end px-[25%]">
              <div
                className="w-full rounded-t-sm bg-accent/80"
                style={{ height: `${(point.b / peak) * height}px` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-meta text-fg-subtle">
        <span>{shown[0]?.month}</span>
        <span>{shown[shown.length - 1]?.month}</span>
      </div>
    </div>
  );
}

/**
 * A 0..1 ratio. `null` renders as "unknown" and never as an empty bar, because
 * an empty bar reads as zero — and the difference between "nobody reviewed this"
 * and "this forge does not record reviews" is the whole point of `precision`.
 */
export function Meter({
  value,
  label,
  tone = "accent",
}: {
  value: number | null;
  label: string;
  tone?: "accent" | "success" | "attention";
}) {
  const fill = { accent: "bg-accent", success: "bg-success", attention: "bg-attention" }[tone];
  return (
    <div>
      <div className="flex items-baseline justify-between text-meta">
        <span className="text-fg-muted">{label}</span>
        <span className="font-mono text-fg">
          {value === null ? "unknown" : `${Math.round(value * 100)}%`}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-raised">
        {value !== null && (
          <div className={`h-full ${fill}`} style={{ width: `${value * 100}%` }} />
        )}
      </div>
    </div>
  );
}

/** A labelled number. The most common thing on both pages, so it is one place. */
export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number | null;
  hint?: string;
}) {
  return (
    <div title={hint}>
      <div className="text-label tracking-wide text-fg-muted uppercase">{label}</div>
      <div className="mt-0.5 font-mono text-lead text-fg">
        {value === null ? <span className="text-fg-subtle">unknown</span> : value}
      </div>
    </div>
  );
}
