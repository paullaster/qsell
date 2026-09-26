'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { setThemeModeAction } from '@/server/domains/theme/actions';
import {
  DEFAULT_THEME_MODE,
  SYSTEM_DARK_QUERY,
  resolveTheme,
  type ResolvedTheme,
  type ThemeMode,
} from '@/config/theme';

interface ThemeContextValue {
  /** The user's raw choice, including "system". */
  mode: ThemeMode;
  /** What is actually painted right now. */
  resolvedTheme: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: DEFAULT_THEME_MODE,
  resolvedTheme: 'light',
  setMode: () => undefined,
});

function subscribeToSystemScheme(onChange: () => void): () => void {
  const query = window.matchMedia(SYSTEM_DARK_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function getSystemScheme(): boolean {
  return window.matchMedia(SYSTEM_DARK_QUERY).matches;
}

/** The server cannot know the OS preference, so it always assumes light. */
function getServerSystemScheme(): boolean {
  return false;
}

/**
 * Writes the scheme to <html>, which is what globals.css keys off. Kept
 * imperative on purpose: the attribute has to move before the browser paints,
 * and React must not own it (the root layout renders the server-side guess).
 */
function applyThemeToDocument(mode: ThemeMode, systemPrefersDark: boolean): void {
  const resolved = resolveTheme(mode, systemPrefersDark);
  const root = document.documentElement;
  root.setAttribute('data-theme-mode', mode);
  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved;
}

export function ThemeProvider({
  initialMode,
  children,
}: {
  initialMode: ThemeMode;
  children: React.ReactNode;
}) {
  const [mode, setModeState] = useState<ThemeMode>(initialMode);
  const hasApplied = useRef(false);

  // Subscribing rather than reading once means a mid-session OS change is
  // picked up live whenever the choice is "system".
  const systemPrefersDark = useSyncExternalStore(
    subscribeToSystemScheme,
    getSystemScheme,
    getServerSystemScheme,
  );

  useEffect(() => {
    // On mount, <html> is already correct: the root layout rendered the
    // account/cookie answer and the pre-paint script settled "system" against
    // the real media query. Correcting it here would race that script and can
    // flash light over dark, so the first pass is deliberately a no-op.
    if (!hasApplied.current) {
      hasApplied.current = true;
      return;
    }
    applyThemeToDocument(mode, systemPrefersDark);
  }, [mode, systemPrefersDark]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    // Optimistic: repaint immediately, the server round-trip only persists it.
    // Read the media query here so the click handler never has to re-subscribe.
    applyThemeToDocument(next, getSystemScheme());
    void setThemeModeAction(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolvedTheme: resolveTheme(mode, systemPrefersDark), setMode }),
    [mode, systemPrefersDark, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
