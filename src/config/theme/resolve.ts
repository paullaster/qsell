import { DEFAULT_THEME_MODE, THEME_MODES, type ResolvedTheme, type ThemeMode } from './types';

/**
 * Non-httpOnly on purpose: the inline pre-paint bootstrap script in the root
 * layout reads it from `document.cookie` before React hydrates.
 */
export const THEME_COOKIE_NAME = 'qs-theme';

/** One year — a scheme preference should outlive a browser session. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
}

/** Coerce anything (cookie value, DB column, form input) to a valid mode. */
export function normalizeThemeMode(value: unknown, fallback: ThemeMode = DEFAULT_THEME_MODE) {
  return isThemeMode(value) ? value : fallback;
}

/**
 * The best server-side guess: only an explicit "dark" cookie can be honoured
 * without a client media query, everything else renders the light default and
 * is corrected before paint by the bootstrap script.
 */
export function resolveThemeForServer(mode: ThemeMode): ResolvedTheme {
  return mode === 'dark' ? 'dark' : 'light';
}

export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light';
  return mode;
}
