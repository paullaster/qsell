/**
 * Colour-scheme preference.
 *
 * `ThemeMode` is the user's raw CHOICE; `ResolvedTheme` is what actually gets
 * painted. They are deliberately separate types so "system" can never leak into
 * a CSS attribute or a `<meta name="color-scheme">` value by accident.
 */
export const THEME_MODES = ['light', 'dark', 'system'] as const;

export type ThemeMode = (typeof THEME_MODES)[number];

export type ResolvedTheme = 'light' | 'dark';

/** Light is the product default — dark mode is opt-in. */
export const DEFAULT_THEME_MODE: ThemeMode = 'light';

/** Media query that backs the "system" option. */
export const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';
