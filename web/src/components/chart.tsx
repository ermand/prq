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
    return <p className="text-2xs text-zinc-600">No activity recorded.</p>;
  }
  const peak = Math.max(1, ...points.map((p) => Math.max(p.a, p.b)));
  // Trailing window: 56 months of history at 4px a bar is wider than any panel,
  // and the recent end is the part anybody reads.
  const shown = points.slice(-36);

  return (
    <div>
      <div className="flex items-center gap-3 text-2xs text-zinc-500">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-zinc-600" />
          {labelA}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-sky-500" />
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
                className="w-full rounded-t-sm bg-zinc-700 group-hover:bg-zinc-500"
                style={{ height: `${(point.a / peak) * height}px` }}
              />
            </div>
            <div className="absolute inset-x-0 bottom-0 flex flex-col justify-end px-[25%]">
              <div
                className="w-full rounded-t-sm bg-sky-500/80"
                style={{ height: `${(point.b / peak) * height}px` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-2xs text-zinc-600">
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
  tone = "sky",
}: {
  value: number | null;
  label: string;
  tone?: "sky" | "emerald" | "amber";
}) {
  const fill = { sky: "bg-sky-500", emerald: "bg-emerald-500", amber: "bg-amber-500" }[tone];
  return (
    <div>
      <div className="flex items-baseline justify-between text-2xs">
        <span className="text-zinc-500">{label}</span>
        <span className="font-mono text-zinc-300">
          {value === null ? "unknown" : `${Math.round(value * 100)}%`}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-800">
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
      <div className="text-2xs tracking-wide text-zinc-500 uppercase">{label}</div>
      <div className="mt-0.5 font-mono text-sm text-zinc-100">
        {value === null ? <span className="text-zinc-600">unknown</span> : value}
      </div>
    </div>
  );
}
