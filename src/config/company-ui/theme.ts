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
  return `#${[clamp(r), clamp(g), clamp(b)]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Lighten toward white by `amount` (0–1). */
export function lightenHex(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const t = Math.max(0, Math.min(1, amount));
  return rgbToHex(
    rgb.r + (255 - rgb.r) * t,
    rgb.g + (255 - rgb.g) * t,
    rgb.b + (255 - rgb.b) * t,
  );
}

export type CompanyThemeColors = {
  primaryColor: string;
  accentColor: string;
};

export type CompanyThemeCssVars = Record<string, string>;

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
