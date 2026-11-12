import { isRecord } from '@/lib/values';

/** Where the package lines of the cart are kept in the browser: ids and counts only; prices are always read from the shop. */
export const PACKAGE_CART_KEY = 'qsell_cart_packages_v1';

export const MAX_PACKAGE_LINES = 20;
export const MAX_SERVINGS = 1000;

export interface PackagePick {
  slotId: string;
  optionId: string;
  count: number;
}

/** One configured package in the cart. `id` names the exact selection, so the same choices are one line and different choices are different lines. */
export interface PackageCartLine {
  id: string;
  productId: string;
  picks: PackagePick[];
  servings: number;
}

/** The same choices in any order give the same key. */
export function packageLineId(productId: string, picks: readonly PackagePick[]): string {
  const merged = new Map<string, number>();
  for (const pick of picks) merged.set(`${pick.slotId}:${pick.optionId}`, (merged.get(`${pick.slotId}:${pick.optionId}`) ?? 0) + pick.count);
  return `${productId}#${[...merged.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}:${String(n)}`).join('|')}`;
}

export function packageLine(productId: string, picks: readonly PackagePick[], servings: number): PackageCartLine {
  const clean = picks.filter((p) => p.count > 0).map((p) => ({ slotId: p.slotId, optionId: p.optionId, count: p.count }));
  return { id: packageLineId(productId, clean), productId, picks: clean, servings: Math.min(MAX_SERVINGS, Math.max(1, Math.floor(servings))) };
}

/** Adds a line; equal choices join the line already there (servings add up, up to the most). Pure. */
export function addPackageLine(lines: readonly PackageCartLine[], incoming: PackageCartLine): PackageCartLine[] {
  const found = lines.find((l) => l.id === incoming.id);
  if (found === undefined) return [...lines, incoming].slice(0, MAX_PACKAGE_LINES);
  return lines.map((l) => (l.id === incoming.id ? { ...l, servings: Math.min(MAX_SERVINGS, l.servings + incoming.servings) } : l));
}

/** Edit: the line with `id` becomes `incoming` in the same place; if that makes it equal to another line, the two join. Pure. */
export function replacePackageLine(lines: readonly PackageCartLine[], id: string, incoming: PackageCartLine): PackageCartLine[] {
  const index = lines.findIndex((l) => l.id === id);
  if (index < 0) return addPackageLine(lines, incoming);
  const without = lines.filter((_, i) => i !== index);
  const twin = without.find((l) => l.id === incoming.id);
  if (twin === undefined) return [...without.slice(0, index), incoming, ...without.slice(index)];
  return without.map((l) => (l.id === incoming.id ? { ...l, servings: Math.min(MAX_SERVINGS, l.servings + incoming.servings) } : l));
}

export const setPackageServings = (lines: readonly PackageCartLine[], id: string, servings: number): PackageCartLine[] =>
  lines.map((l) => (l.id === id ? { ...l, servings: Math.min(MAX_SERVINGS, Math.max(1, Math.floor(servings))) } : l));

export const removePackageLine = (lines: readonly PackageCartLine[], id: string): PackageCartLine[] => lines.filter((l) => l.id !== id);

/** The number added to the cart badge: one per serving. */
export const packageBadgeCount = (lines: readonly PackageCartLine[]): number => lines.reduce((n, l) => n + l.servings, 0);

/** Reads what the browser kept; anything unreadable is dropped, never trusted. */
export function parsePackageCart(raw: string | null): PackageCartLine[] {
  if (raw === null || raw.length === 0 || raw.length > 200_000) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const out: PackageCartLine[] = [];
    for (const entry of value.slice(0, MAX_PACKAGE_LINES)) {
      if (!isRecord(entry) || typeof entry.productId !== 'string' || typeof entry.servings !== 'number' || !Array.isArray(entry.picks)) continue;
      const picks: PackagePick[] = [];
      for (const p of entry.picks.slice(0, 1000)) {
        if (isRecord(p) && typeof p.slotId === 'string' && typeof p.optionId === 'string' && typeof p.count === 'number' && Number.isInteger(p.count) && p.count > 0) picks.push({ slotId: p.slotId, optionId: p.optionId, count: p.count });
      }
      if (entry.productId.length === 0 || entry.productId.length > 100 || !Number.isFinite(entry.servings)) continue;
      const line = packageLine(entry.productId, picks, entry.servings);
      if (!out.some((l) => l.id === line.id)) out.push(line);
    }
    return out;
  } catch {
    return [];
  }
}

export const serializePackageCart = (lines: readonly PackageCartLine[]): string => JSON.stringify(lines.map(({ productId, picks, servings }) => ({ productId, picks, servings })));
