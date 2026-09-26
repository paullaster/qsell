/**
 * Runtime company theme → CSS custom properties.
 * Button/fill indigo tokens in globals.css read these vars so CTAs pick up
 * company colors without rewriting every component.
 */

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!HEX_RE.test(trimmed)) return fallback;
  if (trimmed.length === 4) {
    const r = trimmed[1]!;
    const g = trimmed[2]!;
    const b = trimmed[3]!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return trimmed.toLowerCase();
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const n = normalizeHexColor(hex, '');
  if (!n || n.length !== 7) return null;
  return {
    r: parseInt(n.slice(1, 3), 16),
    g: parseInt(n.slice(3, 5), 16),
    b: parseInt(n.slice(5, 7), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[clamp(r), clamp(g), clamp(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Lighten toward white by `amount` (0–1). */
export function lightenHex(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const t = Math.max(0, Math.min(1, amount));
  return rgbToHex(rgb.r + (255 - rgb.r) * t, rgb.g + (255 - rgb.g) * t, rgb.b + (255 - rgb.b) * t);
}

/** Darken toward black by `amount` (0–1). */
export function darkenHex(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const t = Math.max(0, Math.min(1, amount));
  return rgbToHex(rgb.r * (1 - t), rgb.g * (1 - t), rgb.b * (1 - t));
}

/** WCAG relative luminance of an sRGB colour, 0 (black) → 1 (white). */
function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/**
 * Nudge `hex` toward the readable end of the scheme until it clears `limit`.
 *
 * Company colours are user-supplied, so a fixed lighten/darken amount cannot be
 * trusted to stay legible: a near-black primary needs a big lift in dark mode,
 * a pale pastel needs a big drop in light mode. Stepping in 5% increments caps
 * the work at 20 iterations and guarantees the result is readable.
 */
function ensureLuminance(hex: string, limit: number, lighten: boolean): string {
  let current = hex;
  for (let i = 0; i < 20; i++) {
    const lum = relativeLuminance(current);
    if (lighten ? lum >= limit : lum <= limit) break;
    current = lighten ? lightenHex(current, 0.05) : darkenHex(current, 0.05);
  }
  return current;
}

export type CompanyThemeColors = {
  primaryColor: string;
  accentColor: string;
};

export type CompanyThemeCssVars = Record<string, string>;

/**
 * Per-scheme variants of the company accent, emitted as separate variables so
 * globals.css can pick the right one from `[data-theme]`.
 *
 * `soft` and `faint` are tinted backgrounds (active nav row, icon chips) and
 * `text` is accent-coloured copy. Each is derived from the company primary and
 * then forced past a luminance floor, because the default primary is #111827
 * while a tenant may pick a pale pastel — one fixed lighten amount cannot serve
 * both ends.
 */
function buildAccentVariants(primary: string) {
  return {
    '--company-accent-faint-light': ensureLuminance(lightenHex(primary, 0.9), 0.86, true),
    '--company-accent-soft-light': ensureLuminance(lightenHex(primary, 0.82), 0.66, true),
    '--company-accent-text-light': ensureLuminance(darkenHex(primary, 0.1), 0.16, false),
    '--company-accent-faint-dark': ensureLuminance(lightenHex(primary, 0.72), 0.5, true),
    '--company-accent-soft-dark': ensureLuminance(lightenHex(primary, 0.55), 0.4, true),
    '--company-accent-text-dark': ensureLuminance(lightenHex(primary, 0.3), 0.3, true),
  };
}

/**
 * Build CSS variables for `<html style={...}>`.
 * Invalid colors fall back to safe defaults.
 */
export function buildCompanyThemeCssVars(
  colors: Partial<CompanyThemeColors> | null | undefined,
): CompanyThemeCssVars {
  const primary = normalizeHexColor(colors?.primaryColor, '#111827');
  const accent = normalizeHexColor(colors?.accentColor, '#4f46e5');
  const primaryHover = lightenHex(primary, 0.12);

  return {
    '--company-primary': primary,
    '--company-primary-hover': primaryHover,
    '--company-accent': accent,
    ...buildAccentVariants(primary),
  };
}

/** Inline style string for server-rendered `<html>`. */
export function companyThemeStyleAttribute(
  colors: Partial<CompanyThemeColors> | null | undefined,
): string {
  const vars = buildCompanyThemeCssVars(colors);
  return Object.entries(vars)
    .map(([key, value]) => `${key}:${value}`)
    .join(';');
}
