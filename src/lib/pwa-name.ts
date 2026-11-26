import { has } from '@/lib/values';

/** The longest installed-app name kept: browsers show the full name in the install box and on the opening screen. */
export const APP_NAME_MAX = 45;
/** The longest name that fits under an icon on a home screen before phones cut it off. */
export const APP_SHORT_NAME_MAX = 12;

const JOINERS = /^(&|\+|-|and|na|of|the)$/i;

/** The short name made from a long one: whole words that fit, never a word cut in half (unless the first word alone is too long). */
export function shortNameFrom(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return '';
  const kept: string[] = [];
  let length = 0;
  for (const word of words) {
    const next = length + (kept.length === 0 ? 0 : 1) + word.length;
    if (next > APP_SHORT_NAME_MAX) break;
    kept.push(word);
    length = next;
  }
  // A name must not end on "&" or "and": it would read as unfinished.
  while (kept.length > 1 && JOINERS.test(kept[kept.length - 1] ?? '')) kept.pop();
  return kept.length === 0 ? (words[0] ?? '').slice(0, APP_SHORT_NAME_MAX) : kept.join(' ');
}

export interface InstalledNames {
  /** Shown when installing and on the opening screen. */
  name: string;
  /** Shown under the icon. */
  shortName: string;
}

/**
 * What the installed app is called. The company's own choice wins; without one the trading name is used, and the short name is
 * made from whichever name is in force so it always ends on a whole word.
 */
export function installedNames(company: { tradingName: string; appName?: string | null; appShortName?: string | null }): InstalledNames {
  const chosen = (company.appName ?? '').trim();
  const name = has(chosen) ? chosen : company.tradingName.trim();
  const short = (company.appShortName ?? '').trim();
  return { name, shortName: has(short) ? short : shortNameFrom(name) };
}
