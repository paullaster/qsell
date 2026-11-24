/**
 * SVG path text for the shapes the charts draw. Numbers are rounded to two decimals so the markup stays small and the same
 * input always gives the same text (which the server-rendered page and the browser must agree on).
 */

const r = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * A line through points. A missing value (`null`) breaks the line, so a day with no data is a gap and never a false zero.
 * A single isolated point is drawn as a tiny segment so it stays visible.
 */
export function linePath(
  values: readonly (number | null)[],
  x: (index: number) => number,
  y: (value: number) => number,
): string {
  const parts: string[] = [];
  let drawing = false;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      drawing = false;
      return;
    }
    parts.push(`${drawing ? 'L' : 'M'}${r(x(i))} ${r(y(v))}`);
    drawing = true;
  });
  // A lone point has no segment to show: add a zero-length one with round caps in the stroke style.
  return parts.length === 1 ? `${parts[0] ?? ''}h0.01` : parts.join('');
}

/** A filled area under a line down to `baseline` (a y position). Gaps in the data split the area into pieces. */
export function areaPath(
  values: readonly (number | null)[],
  x: (index: number) => number,
  y: (value: number) => number,
  baseline: number,
): string {
  const pieces: string[] = [];
  let start = -1;
  const close = (end: number) => {
    if (start < 0) return;
    const top: string[] = [];
    for (let i = start; i <= end; i += 1) {
      const v = values[i];
      if (v !== null && v !== undefined)
        top.push(`${i === start ? 'M' : 'L'}${r(x(i))} ${r(y(v))}`);
    }
    pieces.push(`${top.join('')}L${r(x(end))} ${r(baseline)}L${r(x(start))} ${r(baseline)}Z`);
    start = -1;
  };
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      close(i - 1);
    } else if (start < 0) {
      start = i;
    }
  });
  close(values.length - 1);
  return pieces.join('');
}

/** A rectangle with only its top corners rounded (a bar standing on an axis). */
export function barPath(x: number, y: number, width: number, height: number, radius = 3): string {
  const w = Math.max(width, 0);
  const h = Math.max(height, 0);
  const rr = Math.min(radius, w / 2, h);
  if (h === 0 || w === 0) return '';
  return `M${r(x)} ${r(y + h)}V${r(y + rr)}Q${r(x)} ${r(y)} ${r(x + rr)} ${r(y)}H${r(x + w - rr)}Q${r(x + w)} ${r(y)} ${r(x + w)} ${r(y + rr)}V${r(y + h)}Z`;
}

/** A ring segment between two radii and two angles (radians, 0 at the top, clockwise): a donut slice. */
export function arcPath(
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  from: number,
  to: number,
): string {
  const sweep = Math.min(to - from, Math.PI * 2 - 0.0001);
  if (sweep <= 0) return '';
  const point = (radius: number, angle: number): [number, number] => [
    cx + radius * Math.sin(angle),
    cy - radius * Math.cos(angle),
  ];
  const end = from + sweep;
  const [ox0, oy0] = point(outer, from);
  const [ox1, oy1] = point(outer, end);
  const [ix1, iy1] = point(inner, end);
  const [ix0, iy0] = point(inner, from);
  const large = sweep > Math.PI ? 1 : 0;
  return `M${r(ox0)} ${r(oy0)}A${r(outer)} ${r(outer)} 0 ${String(large)} 1 ${r(ox1)} ${r(oy1)}L${r(ix1)} ${r(iy1)}A${r(inner)} ${r(inner)} 0 ${String(large)} 0 ${r(ix0)} ${r(iy0)}Z`;
}

export interface Slice {
  index: number;
  from: number;
  to: number;
  share: number;
}

/** Angles for slices sized by value. Negative and non-finite values count as zero; all zero gives no slices. */
export function sliceAngles(values: readonly number[]): Slice[] {
  const clean = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = clean.reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  let angle = 0;
  const out: Slice[] = [];
  clean.forEach((v, index) => {
    if (v === 0) return;
    const span = (v / total) * Math.PI * 2;
    out.push({ index, from: angle, to: angle + span, share: v / total });
    angle += span;
  });
  return out;
}
