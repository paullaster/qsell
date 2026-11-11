import { normalizeHexColor } from './theme';

/** Text must reach this contrast against its background (WCAG AA for normal text). */
export const MIN_BANNER_CONTRAST = 4.5;

const DARK_TEXT = '#111827';
const LIGHT_TEXT = '#ffffff';
const BLACK = '#000000';

/** `#rrggbb` (lower case) for a valid 3 or 6 digit hex colour, otherwise empty. */
export function bannerColor(value: unknown): string {
  return normalizeHexColor(value, '');
}

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a `#rrggbb` colour (0 black to 1 white). */
export function luminance(hex: string): number {
  const n = bannerColor(hex);
  if (n === '') return 0;
  const r = parseInt(n.slice(1, 3), 16);
  const g = parseInt(n.slice(3, 5), 16);
  const b = parseInt(n.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** How readable one colour is on another: 1 (invisible) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The better of dark and white text for a background. A middle grey can fall short with the soft dark, so black is used then:
 * black or white always reaches at least 4.58 to 1 on any colour.
 */
export function readableTextOn(background: string): string {
  const dark = contrastRatio(DARK_TEXT, background);
  const light = contrastRatio(LIGHT_TEXT, background);
  if (Math.max(dark, light) < MIN_BANNER_CONTRAST) return contrastRatio(BLACK, background) >= light ? BLACK : LIGHT_TEXT;
  return dark >= light ? DARK_TEXT : LIGHT_TEXT;
}

/** True when this text colour can be read on this background. */
export function isReadable(text: string, background: string): boolean {
  return contrastRatio(text, background) >= MIN_BANNER_CONTRAST;
}

/**
 * The text colour that is actually used: the one chosen if it can be read, otherwise whichever of dark or white can.
 * A banner can therefore never show text that cannot be read, whatever was saved.
 */
export function textColorFor(background: string, chosen: string): string {
  const bg = bannerColor(background);
  if (bg === '') return '';
  const text = bannerColor(chosen);
  return text !== '' && isReadable(text, bg) ? text : readableTextOn(bg);
}
