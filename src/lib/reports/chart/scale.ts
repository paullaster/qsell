/**
 * The arithmetic behind every chart: round axis numbers, linear scales and evenly spaced bands. Pure, so each rule can
 * be tested without drawing anything, and the same numbers place a mark on the screen, in a PDF and in an email image.
 */

/** A "nice" number near `range`: 1, 2, 2.5, 5 or 10 times a power of ten (rounded, or the next one up). */
export function niceNumber(range: number, round: boolean): number {
  if (!Number.isFinite(range) || range <= 0) return 1;
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / 10 ** exponent;
  let nice: number;
  if (round) {
    if (fraction < 1.5) nice = 1;
    else if (fraction < 3) nice = 2;
    else if (fraction < 7) nice = 5;
    else nice = 10;
  } else if (fraction <= 1) nice = 1;
  else if (fraction <= 2) nice = 2;
  else if (fraction <= 5) nice = 5;
  else nice = 10;
  return nice * 10 ** exponent;
}

export interface NiceAxis {
  /** First and last tick: the axis runs between them. */
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

/**
 * Axis limits and tick values that read as round numbers (0, 5K, 10K), covering [min, max]. The axis always includes zero when
 * every value is on one side of it, because a bar that does not start at zero tells a false story.
 */
export function niceAxis(min: number, max: number, target = 5): NiceAxis {
  let lo = Number.isFinite(min) ? Math.min(min, 0) : 0;
  let hi = Number.isFinite(max) ? Math.max(max, 0) : 0;
  if (lo === hi) hi = lo + 1;
  const step = niceNumber(niceNumber(hi - lo, false) / Math.max(target - 1, 1), true);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  const count = Math.round((hi - lo) / step);
  for (let i = 0; i <= count; i += 1) ticks.push(roundTo(lo + i * step, step));
  return { min: lo, max: hi, step, ticks };
}

/** Removes the float noise that building ticks by repeated addition leaves (0.30000000000000004 becomes 0.3). */
function roundTo(value: number, step: number): number {
  const decimals = step >= 1 ? 0 : Math.min(10, Math.ceil(-Math.log10(step)) + 1);
  return Number(value.toFixed(decimals));
}

/** A linear map from a domain to a range. A flat domain maps everything to the middle of the range. */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): (value: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  if (d0 === d1) return () => (r0 + r1) / 2;
  const k = (r1 - r0) / (d1 - d0);
  return (value) => r0 + (value - d0) * k;
}

export interface Band {
  /** Left edge of band `i`. */
  readonly start: (i: number) => number;
  /** Centre of band `i`. */
  readonly center: (i: number) => number;
  /** Width of the drawn mark inside each band. */
  width: number;
  /** Distance from one band's start to the next. */
  step: number;
}

/** `count` evenly spaced bands across `range`, with `padding` (0 to 0.9) as the share of each slot left empty. */
export function bandScale(count: number, range: readonly [number, number], padding = 0.2): Band {
  const n = Math.max(1, Math.floor(count));
  const pad = Math.min(Math.max(padding, 0), 0.9);
  const total = range[1] - range[0];
  const step = total / n;
  const width = step * (1 - pad);
  const offset = (step - width) / 2;
  return {
    start: (i) => range[0] + i * step + offset,
    center: (i) => range[0] + i * step + step / 2,
    width,
    step,
  };
}

/** The index of the band under a pointer position (clamped to the first and last band). */
export function bandIndexAt(
  position: number,
  count: number,
  range: readonly [number, number],
): number {
  const n = Math.max(1, Math.floor(count));
  const total = range[1] - range[0];
  if (total <= 0) return 0;
  return Math.min(n - 1, Math.max(0, Math.floor(((position - range[0]) / total) * n)));
}
