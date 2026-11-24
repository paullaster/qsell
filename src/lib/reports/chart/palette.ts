/**
 * The colours charts use. Three families, each defined for light and dark and kept in step with the CSS tokens in
 * `app/globals.css` (a test compares them):
 *   - categorical: up to eight series that must be told apart (branches, products, payment methods);
 *   - sequential: one hue from light to strong, for how much (heat maps, shading);
 *   - diverging: two hues around a neutral middle, for above and below a reference (variance, favourable or not).
 *
 * The choices follow a colour-blind-safe scheme (blue, vermillion, green, and so on) and are checked by code: every colour
 * keeps at least 3:1 contrast with the surface it sits on in its theme (the WCAG minimum for graphics), and the series most
 * often drawn together stay distinguishable under the three common kinds of colour-vision deficiency.
 */

export type Theme = 'light' | 'dark';

export interface ThemePalette {
  /** The surfaces a chart is drawn on (panel and raised panel), for contrast checks. */
  surfaces: readonly [string, string];
  categorical: readonly string[];
  sequential: readonly string[];
  diverging: readonly string[];
}

export const PALETTE: Record<Theme, ThemePalette> = {
  light: {
    surfaces: ['#ffffff', '#fafafa'],
    categorical: [
      '#0072b2',
      '#d55e00',
      '#2a9d3f',
      '#b5528a',
      '#8a5a44',
      '#a87900',
      '#6a51a3',
      '#6b7280',
    ],
    sequential: ['#eaf2fb', '#bcd7ef', '#7fb2de', '#3f86c4', '#14518f'],
    diverging: ['#b2410e', '#e39a64', '#e5e7eb', '#7fb2de', '#14518f'],
  },
  dark: {
    surfaces: ['#09090b', '#18181b'],
    categorical: [
      '#4da3e0',
      '#f08a3c',
      '#3cc79b',
      '#e08dbb',
      '#c58b6d',
      '#e6b422',
      '#a78bfa',
      '#9ca3af',
    ],
    sequential: ['#10243a', '#17416b', '#2663a3', '#4f8fd1', '#9cc4ec'],
    diverging: ['#f08a3c', '#a65a24', '#3f3f46', '#2663a3', '#9cc4ec'],
  },
};

/** The CSS custom property that holds a colour, so components never repeat a hex value. */
export const categoricalVar = (index: number): string => `var(--data-${String((index % 8) + 1)})`;
export const sequentialVar = (step: number): string =>
  `var(--seq-${String(Math.min(5, Math.max(1, step)))})`;
export const divergingVar = (step: number): string =>
  `var(--div-${String(Math.min(5, Math.max(1, step)))})`;

/**
 * A stable colour slot (0 to 7) for a name or an id, so a branch or a product keeps its colour on every chart and every
 * page. The same text always gives the same slot; different texts spread across the slots.
 */
export function colorSlotFor(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 8;
}

// ---------- colour maths (used by the tests and by anything that needs to check a colour) ----------

export type Rgb = readonly [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (m === null) throw new Error(`Not a six-digit hex colour: ${hex}`);
  const n = parseInt(m[1] ?? '000000', 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toLinear = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb;
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export type Deficiency = 'protanopia' | 'deuteranopia' | 'tritanopia';

// Machado, Oliveira and Fernandes (2009) matrices at full severity, applied to linear RGB.
const CVD: Record<Deficiency, readonly (readonly [number, number, number])[]> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

const fromLinear = (c: number): number => {
  const v = Math.min(1, Math.max(0, c));
  return Math.round((v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
};

/** How a colour looks to someone with the given deficiency. */
export function simulate(rgb: Rgb, kind: Deficiency): Rgb {
  const lin: [number, number, number] = [toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])];
  const m = CVD[kind];
  const out = m.map((row) => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]);
  return [fromLinear(out[0] ?? 0), fromLinear(out[1] ?? 0), fromLinear(out[2] ?? 0)];
}

/** CIE L*a*b* of an sRGB colour (D65). */
export function lab(rgb: Rgb): readonly [number, number, number] {
  const [r, g, b] = [toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])];
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** Perceptual distance between two colours (CIE76). About 2 is barely visible; above 10 is clearly different. */
export function deltaE(a: Rgb, b: Rgb): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}
