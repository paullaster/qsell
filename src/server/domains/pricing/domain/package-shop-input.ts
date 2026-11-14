import { PACKAGE_LIMITS } from './packages';
import type { PackageLineInput } from './package-shop';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const idOf = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 && value.length <= 100 ? value : null);

/**
 * Reads one package line from the browser: a package product id, the servings and the picks (slot id, option id, count).
 * Nothing about price or stock is read; anything that is not an id or a whole number is dropped or the line is refused (null).
 */
export function parsePackageLine(raw: unknown): PackageLineInput | null {
  if (!isRecord(raw)) return null;
  const productId = idOf(raw.productId);
  const servings = raw.servings;
  if (productId === null || typeof servings !== 'number' || !Number.isFinite(servings)) return null;
  const rawPicks = Array.isArray(raw.picks) ? raw.picks : [];
  const picks: PackageLineInput['picks'] = [];
  // A cap on the work: no basket line can carry more picks than a package can have.
  for (const entry of rawPicks.slice(0, PACKAGE_LIMITS.slots * PACKAGE_LIMITS.optionsPerSlot)) {
    if (!isRecord(entry)) continue;
    const slotId = idOf(entry.slotId);
    const optionId = idOf(entry.optionId);
    const count = entry.count;
    if (slotId === null || optionId === null || typeof count !== 'number' || !Number.isFinite(count)) continue;
    picks.push({ slotId, optionId, count });
  }
  return { productId, servings, picks, ...(typeof raw.note === 'string' && raw.note.trim() !== '' ? { note: raw.note.slice(0, PACKAGE_LIMITS.note + 1) } : {}) };
}

/** A basket's package lines, at most twenty; lines that cannot be read are dropped. */
export function parsePackageLines(raw: unknown): PackageLineInput[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).flatMap((entry) => {
    const line = parsePackageLine(entry);
    return line === null ? [] : [line];
  });
}

/** Servings for an availability question: a whole number from 1, otherwise one. */
export function parseServings(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= PACKAGE_LIMITS.servings ? raw : 1;
}
