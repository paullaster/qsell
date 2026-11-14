import { canonicalSelection, PACKAGE_LIMITS, servingPrice, type CanonicalPick, type PackageDef, type PackagePricingMode, type RawPick, type ShortStockMode } from './packages';

/**
 * What the web shop may know about a package: names, the rules in words and the price of each option, and nothing about cost,
 * stock counts or suppliers. Built on the server; the browser only draws it.
 */
export interface ShopOption {
  id: string;
  /** The product behind the option, so stock is counted per product however many options use it. */
  productId: string;
  name: string;
  /** Units of the product in one pick. */
  quantity: number;
  /** Added to the base price per pick (base-plus-differences mode). */
  difference: number;
  /** What one pick sells for (summed mode); null when it has no price. */
  price: number | null;
  isDefault: boolean;
}

export interface ShopSlot {
  id: string;
  name: string;
  helpText: string;
  minPicks: number;
  maxPicks: number;
  allowRepeats: boolean;
  included: boolean;
  options: ShopOption[];
}

export interface ShopPackage {
  productId: string;
  name: string;
  basePrice: number;
  pricingMode: PackagePricingMode;
  shortStockMode: ShortStockMode;
  version: number;
  /** The customer may write a note on a serving. */
  allowNote: boolean;
  slots: ShopSlot[];
}

/** One line of a basket as the browser sends it: ids and counts only, never a price. */
export interface PackageLineInput {
  productId: string;
  picks: RawPick[];
  servings: number;
  /** What the customer wrote on the serving ("no pepper"); only where the package allows it. */
  note?: string;
}

/** Free units of each product and which products are never counted (services, non-stock items). */
export interface LineStock {
  free: ReadonlyMap<string, number>;
  unlimited: ReadonlySet<string>;
}

export type LineCheck =
  | {
      ok: true;
      key: string;
      servings: number;
      servingPrice: number;
      total: number;
      /** The note as kept (trimmed). */
      note: string;
      /** "Express lunch: medium fish, brown ugali and sukuma" */
      summary: string;
      /** What this line takes from stock, so the next line of the same basket sees what is left. */
      used: Map<string, number>;
    }
  | { ok: false; problems: string[] };

/** A basket line's answer, safe to send to the browser (no internal bookkeeping). */
export type BasketLineView = { ok: true; key: string; servings: number; servingPrice: number; total: number; summary: string; note: string } | { ok: false; problems: string[] };

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** The pure definition the rules work on, from the shop's view of a package (cost is not known here and not needed to price). */
export function shopDefinition(pkg: ShopPackage): PackageDef {
  return {
    productId: pkg.productId,
    pricingMode: pkg.pricingMode,
    allocation: 'list_price',
    slots: pkg.slots.map((slot) => ({
      id: slot.id,
      name: slot.name,
      minPicks: slot.minPicks,
      maxPicks: slot.maxPicks,
      allowRepeats: slot.allowRepeats,
      included: slot.included,
      options: slot.options.map((o) => ({ id: o.id, productId: o.productId, quantity: o.quantity, difference: o.difference, price: o.price, cost: 0, weight: null, isDefault: o.isDefault })),
    })),
  };
}

/** A list in words: "a", "a and b", "a, b and c". */
export function wordsList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/** The picks as a sentence the shopper can read in the basket. */
export function selectionSentence(name: string, picks: readonly CanonicalPick[], names: ReadonlyMap<string, string>): string {
  const parts = picks.map((pick) => {
    const label = names.get(pick.optionId) ?? 'an option';
    return pick.count > 1 ? `${String(pick.count)} × ${label}` : label;
  });
  return parts.length === 0 ? name : `${name}: ${wordsList(parts)}`;
}

/**
 * Checks one basket line: whole servings, a selection that belongs to the package and meets every slot's least and most, a price
 * that is not below zero, and stock for all the servings, counting what the lines before it already take. Prices come from the
 * package, never from the browser.
 *
 * `used` is the stock already taken by earlier lines of the same basket (updated by the caller with this line's `used`).
 */
export function checkPackageLine(pkg: ShopPackage, line: PackageLineInput, stock: LineStock, used: ReadonlyMap<string, number> = new Map()): LineCheck {
  const def = shopDefinition(pkg);
  const servings = line.servings;
  if (!Number.isInteger(servings) || servings < 1 || servings > PACKAGE_LIMITS.servings) {
    return { ok: false, problems: [`Servings must be a whole number from 1 to ${String(PACKAGE_LIMITS.servings)}.`] };
  }
  const note = (line.note ?? '').trim();
  if (note !== '' && !pkg.allowNote) return { ok: false, problems: [`${pkg.name} does not take a note.`] };
  const selection = canonicalSelection(def, line.picks, note);
  if (!selection.ok) return { ok: false, problems: selection.problems.map((p) => p.message) };
  const each = servingPrice(def, selection.picks, pkg.basePrice);
  if (each === null) return { ok: false, problems: ['This choice cannot be priced. Please change it.'] };

  const names = new Map(pkg.slots.flatMap((slot) => slot.options.map((o) => [o.id, o.name] as const)));
  const take = new Map<string, number>();
  const labelOf = new Map<string, string>();
  for (const pick of selection.picks) {
    const productId = pick.option.productId;
    take.set(productId, (take.get(productId) ?? 0) + pick.option.quantity * pick.count * servings);
    if (!labelOf.has(productId)) labelOf.set(productId, names.get(pick.optionId) ?? 'An option');
  }
  const problems: string[] = [];
  for (const [productId, need] of take) {
    if (stock.unlimited.has(productId)) continue;
    const free = (stock.free.get(productId) ?? 0) - (used.get(productId) ?? 0);
    if (free + 1e-9 < need) {
      const label = labelOf.get(productId) ?? 'An option';
      problems.push(free <= 0 ? `${label} is sold out.` : `${label} is sold out for ${String(servings)} ${servings === 1 ? 'serving' : 'servings'}.`);
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    key: selection.key,
    servings,
    servingPrice: each,
    total: round2(each * servings),
    note,
    summary: selectionSentence(pkg.name, selection.picks, names),
    used: take,
  };
}

/** Checks a whole basket in order; each line sees what the lines before it took, so two servings never share the last portion. */
export function checkPackageBasket(packages: ReadonlyMap<string, ShopPackage>, lines: readonly PackageLineInput[], stock: LineStock): LineCheck[] {
  const used = new Map<string, number>();
  return lines.map((line) => {
    const pkg = packages.get(line.productId);
    if (pkg === undefined) return { ok: false, problems: ['This package is not available any more.'] } satisfies LineCheck;
    const result = checkPackageLine(pkg, line, stock, used);
    if (result.ok) for (const [id, n] of result.used) used.set(id, (used.get(id) ?? 0) + n);
    return result;
  });
}

/** The options of a slot to draw, after the short-stock rule (`available` holds option ids). */
export function optionsToShow(slot: ShopSlot, available: ReadonlySet<string>, mode: ShortStockMode): { option: ShopOption; available: boolean; suggestion: string | null }[] {
  const firstOk = slot.options.find((o) => available.has(o.id));
  const rows = slot.options.map((option) => ({ option, available: available.has(option.id), suggestion: null as string | null }));
  const shown = mode === 'hide' ? rows.filter((r) => r.available) : rows;
  return shown.map((r) => ({ ...r, suggestion: !r.available && mode === 'substitute' ? (firstOk?.id ?? null) : null }));
}

/** The package can be offered when every slot that needs a pick still has enough available options. */
export function packageAvailable(pkg: ShopPackage, available: ReadonlySet<string>): boolean {
  return pkg.slots.every((slot) => {
    const needed = slot.included ? 1 : slot.minPicks;
    if (needed === 0) return true;
    const count = slot.options.filter((o) => available.has(o.id)).length;
    return count >= (slot.allowRepeats ? 1 : needed);
  });
}

/**
 * A selection as a quote keeps it: by the slot's name and the part's product, not by option ids (a package that is changed gets new
 * ids, but a quote made yesterday must still be understood today). The name is what the customer was shown.
 */
export interface StoredPick {
  slotName: string;
  productId: string;
  name: string;
  count: number;
}

/** The picks as a quote keeps them. */
export function storedPicks(pkg: ShopPackage, picks: readonly RawPick[]): StoredPick[] {
  return picks.flatMap((pick) => {
    const slot = pkg.slots.find((s) => s.id === pick.slotId);
    const option = slot?.options.find((o) => o.id === pick.optionId);
    return slot === undefined || option === undefined ? [] : [{ slotName: slot.name, productId: option.productId, name: option.name, count: pick.count }];
  });
}

export type ResolvedPicks = { ok: true; picks: RawPick[] } | { ok: false; problems: string[] };

/** Finds today's slots and options for what a quote kept; anything the package no longer offers is named, so a replacement can be chosen. */
export function resolveStoredPicks(pkg: ShopPackage, stored: readonly StoredPick[]): ResolvedPicks {
  const picks: RawPick[] = [];
  const problems: string[] = [];
  const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
  for (const pick of stored) {
    const slot = pkg.slots.find((s) => same(s.name, pick.slotName));
    const option = slot?.options.find((o) => o.productId === pick.productId);
    if (slot === undefined || option === undefined) problems.push(`${pick.name} is no longer offered in ${pick.slotName}.`);
    else picks.push({ slotId: slot.id, optionId: option.id, count: pick.count });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, picks };
}

/** What a quote kept, as far as the package still offers it: the picks that are found, and the names of those that are not (to be chosen again). */
export function resolveStoredPicksLenient(pkg: ShopPackage, stored: readonly StoredPick[]): { picks: RawPick[]; missing: string[] } {
  const picks: RawPick[] = [];
  const missing: string[] = [];
  for (const pick of stored) {
    const found = resolveStoredPicks(pkg, [pick]);
    if (found.ok) picks.push(...found.picks);
    else missing.push(pick.name);
  }
  return { picks, missing };
}

/** The choices of a stored selection as words: "Large fish, Ugali and 2 × Sukuma". */
export const storedWords = (picks: readonly StoredPick[]): string => wordsList(picks.map((p) => (p.count > 1 ? `${String(p.count)} × ${p.name}` : p.name)));
