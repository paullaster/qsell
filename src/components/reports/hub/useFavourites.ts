'use client';

import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'qsell_report_favourites_v1';
const CHANGED = 'qsell-report-favourites';

/** The saved list as text; anything that is not a list of short words is dropped. Kept as text so equal lists are equal. */
function read(): string {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    const codes = Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string' && x.length <= 80).slice(0, 100)
      : [];
    return JSON.stringify(codes);
  } catch {
    return '[]';
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

/**
 * Starred reports, kept in this browser only (a convenience that never needs to follow the person anywhere else). Where
 * storage is blocked a star simply does not stick. The server and the first paint see an empty list, so the page and the
 * browser agree and the stars appear a moment later without a mismatch.
 */
export function useFavourites(): { favourites: readonly string[]; toggle: (code: string) => void } {
  const snapshot = useSyncExternalStore(subscribe, read, () => '[]');
  const favourites = JSON.parse(snapshot) as string[];
  const toggle = useCallback((code: string) => {
    const current = JSON.parse(read()) as string[];
    const next = current.includes(code) ? current.filter((c) => c !== code) : [...current, code];
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage may be blocked (a private window); the star then lasts only until the page is left.
    }
    window.dispatchEvent(new Event(CHANGED));
  }, []);
  return { favourites, toggle };
}
