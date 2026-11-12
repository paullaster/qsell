/**
 * Configurable packages: one product made of choices (docs/architecture/configurable-packages.md).
 *
 * Everything here is pure: the definition, the stock, the prices and the clock are passed in, so every selling document (web
 * shop, quote, staff order and, later, the point of sale, sales orders, invoices and credit sales) calls the same rules.
 */
import { allocateKit, type KitAllocation, type KitComponentDef, type KitPart } from './kits';

export const PRICING_MODES = ['base_plus_differences', 'summed'] as const;
export type PackagePricingMode = (typeof PRICING_MODES)[number];
export type ShortStockMode = 'hide' | 'disable' | 'substitute';

export const PACKAGE_LIMITS = { slots: 20, optionsPerSlot: 50, picksPerSlot: 50, servings: 1000, note: 200 } as const;

export interface PackageOptionDef {
  id: string;
  productId: string;
  /** Units of the product in one pick, in its base unit. */
  quantity: number;
  /** Base-plus-differences mode: added to the base price per pick (may be zero or negative). */
  difference: number;
  /**
   * What one pick sells for on its own, already worked out by the caller (the product's own price through the price engine times
   * the quantity, or a fixed amount for this package). Summed mode charges it; base-plus-differences mode only uses it to split
   * the line's price over the parts by price. Null when the option has no price (refused in summed mode).
   */
  price: number | null;
  /** What one pick costs the business, for the split by cost, the price floor and the below-cost check. */
  cost: number;
  /** For the split by shares you set. */
  weight: number | null;
  isDefault: boolean;
}

export interface PackageSlotDef {
  id: string;
  name: string;
  minPicks: number;
  maxPicks: number;
  allowRepeats: boolean;
  /** An included slot has one option and is not asked: it is always part of a serving. */
  included: boolean;
  options: PackageOptionDef[];
}

export interface PackageDef {
  productId: string;
  pricingMode: PackagePricingMode;
  allocation: KitAllocation;
  slots: PackageSlotDef[];
}

/** What a shopper chose: how many of an option in a slot. */
export interface RawPick {
  slotId: string;
  optionId: string;
  count: number;
}

export interface PackageProblem {
  path: string;
  message: string;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= PACKAGE_LIMITS.picksPerSlot;

/** Checks a package's definition (the same checks run when it is saved). */
export function checkPackage(def: PackageDef, validProductIds?: ReadonlySet<string>, otherPackageOrKitIds: ReadonlySet<string> = new Set()): PackageProblem[] {
  const out: PackageProblem[] = [];
  if (!PRICING_MODES.some((mode) => mode === def.pricingMode)) out.push({ path: 'pricingMode', message: 'Choose how the package is priced.' });
  if (def.slots.length === 0) out.push({ path: 'slots', message: 'Add at least one slot.' });
  if (def.slots.length > PACKAGE_LIMITS.slots) out.push({ path: 'slots', message: `A package can have at most ${String(PACKAGE_LIMITS.slots)} slots.` });
  const slotIds = new Set<string>();
  def.slots.forEach((slot, si) => {
    const at = `slots.${String(si)}`;
    if (slotIds.has(slot.id)) out.push({ path: at, message: 'Two slots have the same identity.' });
    slotIds.add(slot.id);
    if (slot.name.trim() === '') out.push({ path: at, message: 'Give every slot a name.' });
    if (!Number.isInteger(slot.minPicks) || !Number.isInteger(slot.maxPicks) || slot.minPicks < 0 || slot.maxPicks < 1) out.push({ path: at, message: `${slot.name}: the least is 0 or more and the most is 1 or more, in whole numbers.` });
    else if (slot.minPicks > slot.maxPicks) out.push({ path: at, message: `${slot.name}: the least cannot be more than the most.` });
    if (slot.maxPicks > PACKAGE_LIMITS.picksPerSlot) out.push({ path: at, message: `${slot.name}: at most ${String(PACKAGE_LIMITS.picksPerSlot)} picks.` });
    if (slot.options.length === 0) out.push({ path: at, message: `${slot.name} needs at least one option.` });
    if (slot.options.length > PACKAGE_LIMITS.optionsPerSlot) out.push({ path: at, message: `${slot.name}: at most ${String(PACKAGE_LIMITS.optionsPerSlot)} options.` });
    if (slot.included && !(slot.options.length === 1 && slot.minPicks === 1 && slot.maxPicks === 1)) out.push({ path: at, message: `${slot.name}: an included slot has exactly one option and exactly one pick.` });
    if (slot.options.filter((o) => o.isDefault).reduce((n) => n + 1, 0) > slot.maxPicks) out.push({ path: at, message: `${slot.name}: more defaults than the most picks.` });
    const products = new Set<string>();
    slot.options.forEach((option, oi) => {
      const optionAt = `${at}.options.${String(oi)}`;
      if (option.productId === def.productId) out.push({ path: optionAt, message: 'A package cannot contain itself.' });
      if (otherPackageOrKitIds.has(option.productId)) out.push({ path: optionAt, message: 'A package cannot contain another package or a kit.' });
      if (validProductIds !== undefined && !validProductIds.has(option.productId)) out.push({ path: optionAt, message: 'This product no longer exists or cannot be sold.' });
      if (products.has(option.productId)) out.push({ path: optionAt, message: `${slot.name}: the same product is listed twice.` });
      products.add(option.productId);
      if (!(option.quantity > 0) || Math.round(option.quantity * 1000) / 1000 !== option.quantity) out.push({ path: optionAt, message: 'Each option needs a quantity above zero, with at most 3 decimals.' });
      if (def.pricingMode === 'summed' && (option.price === null || option.price < 0)) out.push({ path: optionAt, message: 'In summed pricing every option needs a price of 0 or more.' });
      if (def.allocation === 'explicit' && !(option.weight !== null && option.weight > 0)) out.push({ path: optionAt, message: 'Give every option a share above zero.' });
    });
  });
  return out;
}

export interface CanonicalPick extends RawPick {
  option: PackageOptionDef;
}

export type CanonicalResult = { ok: true; picks: CanonicalPick[]; key: string } | { ok: false; problems: PackageProblem[] };

/**
 * Turns what a shopper sent into the one canonical selection, or says what is wrong. Anything that does not belong to the package
 * is refused; included slots are filled in; the picks are put in the package's own order so the same choices always give the same key.
 */
export function canonicalSelection(def: PackageDef, raw: readonly RawPick[], note = ''): CanonicalResult {
  const problems: PackageProblem[] = [];
  const counts = new Map<string, number>();
  for (const pick of raw) {
    const slot = def.slots.find((s) => s.id === pick.slotId);
    const option = slot?.options.find((o) => o.id === pick.optionId);
    if (slot === undefined || option === undefined) {
      problems.push({ path: 'selection', message: 'A choice does not belong to this package.' });
      continue;
    }
    if (!isCount(pick.count)) {
      problems.push({ path: slot.id, message: `${slot.name}: a choice needs a whole number from 1.` });
      continue;
    }
    const key = `${slot.id}\u0000${option.id}`;
    // The same option sent twice is one choice with the counts added, so a double tap cannot slip past the limits.
    counts.set(key, (counts.get(key) ?? 0) + pick.count);
  }
  const picks: CanonicalPick[] = [];
  for (const slot of def.slots) {
    let total = 0;
    for (const option of slot.options) {
      let count = counts.get(`${slot.id}\u0000${option.id}`) ?? 0;
      if (slot.included && option === slot.options[0]) count = 1;
      if (count === 0) continue;
      if (count > 1 && !slot.allowRepeats) problems.push({ path: slot.id, message: `${slot.name}: an option can be chosen only once.` });
      total += count;
      picks.push({ slotId: slot.id, optionId: option.id, count, option });
    }
    if (total < slot.minPicks) problems.push({ path: slot.id, message: slot.minPicks === 1 ? `Choose an option for ${slot.name}.` : `Choose at least ${String(slot.minPicks)} for ${slot.name}.` });
    if (total > slot.maxPicks) problems.push({ path: slot.id, message: `Choose at most ${String(slot.maxPicks)} for ${slot.name}.` });
  }
  const cleanNote = note.trim();
  if (cleanNote.length > PACKAGE_LIMITS.note) problems.push({ path: 'note', message: `The note can be at most ${String(PACKAGE_LIMITS.note)} characters.` });
  if (problems.length > 0) return { ok: false, problems };
  const key = `${picks.map((p) => `${p.slotId}:${p.optionId}:${String(p.count)}`).join('|')}#${cleanNote}`;
  return { ok: true, picks, key };
}

/**
 * The price of one serving. Base plus differences: the base price plus each pick's difference. Summed: the sum of the picks' own
 * prices. A serving below zero is refused (null) and a free one is allowed.
 */
export function servingPrice(def: Pick<PackageDef, 'pricingMode'>, picks: readonly CanonicalPick[], basePrice: number): number | null {
  let total = def.pricingMode === 'summed' ? 0 : basePrice;
  for (const pick of picks) {
    if (def.pricingMode === 'summed') {
      if (pick.option.price === null) return null;
      total += pick.option.price * pick.count;
    } else {
      total += pick.option.difference * pick.count;
    }
  }
  total = round2(total);
  return total < 0 ? null : total;
}

/** What one serving costs the business, for the price floor on the selection actually chosen. */
export const servingCost = (picks: readonly CanonicalPick[]): number => round2(picks.reduce((n, p) => n + p.option.cost * p.count, 0));

/**
 * The parts of a line: the line's price (after discounts) shared over the chosen options, like a kit's. Parts of the same product
 * (chosen in two slots) are one part. In summed mode each part takes its own price because the split is by price.
 */
export function packageParts(def: Pick<PackageDef, 'pricingMode' | 'allocation'>, picks: readonly CanonicalPick[], linePrice: number, servings: number): KitPart[] {
  return allocateKit(round2(linePrice), servings, packageComponentDefs(picks), def.allocation);
}

/** The chosen options as kit components for one serving, a product chosen twice being one component (weighted averages of price and cost). */
export function packageComponentDefs(picks: readonly CanonicalPick[]): KitComponentDef[] {
  const byProduct = new Map<string, KitComponentDef>();
  for (const pick of picks) {
    const quantity = pick.option.quantity * pick.count;
    const price = (pick.option.price ?? 0) * pick.count;
    const found = byProduct.get(pick.option.productId);
    if (found === undefined) {
      byProduct.set(pick.option.productId, { productId: pick.option.productId, quantity, price: price / Math.max(quantity, 0.0001), cost: pick.option.cost * pick.count / Math.max(quantity, 0.0001), weight: pick.option.weight === null ? null : pick.option.weight * pick.count });
    } else {
      const totalQuantity = found.quantity + quantity;
      found.price = (found.price * found.quantity + price) / totalQuantity;
      found.cost = (found.cost * found.quantity + pick.option.cost * pick.count) / totalQuantity;
      found.weight = found.weight === null || pick.option.weight === null ? null : found.weight + pick.option.weight * pick.count;
      found.quantity = totalQuantity;
    }
  }
  return [...byProduct.values()];
}

export interface Availability {
  optionId: string;
  available: boolean;
  /** Plain words for a person when it is not available. */
  reason: string | null;
}

export interface SlotView {
  slotId: string;
  /** The options to show, in order, after the short-stock rule. */
  options: (Availability & { option: PackageOptionDef; suggestion: string | null })[];
  /** True when the shopper can still satisfy this slot's least picks. */
  satisfiable: boolean;
}

export interface StockFacts {
  /** Units of each product free to sell here, now. */
  free: ReadonlyMap<string, number>;
  /** Units of each product already taken by the rest of the basket (other lines), so servings do not share the last portion. */
  taken: ReadonlyMap<string, number>;
  /** Products that are not counted (services, non-stock items) and so never limit availability. */
  unlimited: ReadonlySet<string>;
}

/**
 * Which options can be chosen for this many servings, and what to show for the ones that cannot (hide, grey out, or suggest the
 * nearest). A required slot that cannot be satisfied makes the whole package unavailable.
 */
export function packageAvailability(def: PackageDef, stock: StockFacts, servings: number, mode: ShortStockMode): { slots: SlotView[]; available: boolean } {
  const slots = def.slots.map((slot): SlotView => {
    const checked = slot.options.map((option) => {
      const need = option.quantity * servings;
      const free = stock.unlimited.has(option.productId) ? Number.POSITIVE_INFINITY : (stock.free.get(option.productId) ?? 0) - (stock.taken.get(option.productId) ?? 0);
      const ok = free + 1e-9 >= need;
      return { option, optionId: option.id, available: ok, reason: ok ? null : 'Sold out for this many servings' };
    });
    const firstOk = checked.find((c) => c.available);
    const shown = (mode === 'hide' ? checked.filter((c) => c.available) : checked).map((c) => ({ ...c, suggestion: !c.available && mode === 'substitute' ? (firstOk?.optionId ?? null) : null }));
    const availableCount = checked.filter((c) => c.available).length;
    const needed = slot.included ? 1 : slot.minPicks;
    return { slotId: slot.id, options: shown, satisfiable: availableCount >= needed };
  });
  return { slots, available: slots.every((s) => s.satisfiable) };
}

/** The cheapest valid selection (for the "from" price and the below-cost check): the cheapest options needed to meet every slot's least. */
export function cheapestSelection(def: PackageDef): CanonicalPick[] {
  const contribution = (o: PackageOptionDef): number => (def.pricingMode === 'summed' ? (o.price ?? 0) : o.difference);
  const picks: CanonicalPick[] = [];
  for (const slot of def.slots) {
    const need = slot.included ? 1 : slot.minPicks;
    const sorted = [...slot.options].sort((a, b) => contribution(a) - contribution(b));
    let left = need;
    for (const option of sorted) {
      if (left <= 0) break;
      const count = slot.allowRepeats ? left : 1;
      picks.push({ slotId: slot.id, optionId: option.id, count, option });
      left -= count;
    }
  }
  return picks;
}

/** Whether the cheapest valid selection sells for less than it costs: the package could be configured below cost. */
export function belowCostWhenCheapest(def: PackageDef, basePrice: number): { below: boolean; price: number | null; cost: number } {
  const picks = cheapestSelection(def);
  const price = servingPrice(def, picks, basePrice);
  const cost = servingCost(picks);
  return { below: price === null || price < cost, price, cost };
}

export interface OrderingRules {
  minServings: number | null;
  maxServings: number | null;
  /** The shortest time between ordering and the date's start of service, in minutes. */
  noticeMinutes: number | null;
  /** Orders for a date close this many days before it, at this minute of the day. */
  closesDaysBefore: number | null;
  closesAtMinute: number | null;
  /** Days of the week (0 Sunday to 6) the package can be fulfilled on; empty means every day. */
  weekdays: number[];
  /** The most servings that can be promised for one date. */
  dailyLimit: number | null;
}

/** A moment in the company's own time: the date and the minute of that day. The caller works it out in the company's time zone. */
export interface LocalMoment {
  date: string;
  minute: number;
}

const dayNumber = (date: string): number => Math.floor(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86_400_000);
const weekday = (date: string): number => (dayNumber(date) + 4) % 7;
const clock = (minute: number): string => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** The first rule an order breaks, in plain words, or null. Served date `for` and the minute service starts are in the company's time. */
export function orderingProblem(
  rules: OrderingRules,
  now: LocalMoment,
  fulfilment: LocalMoment | null,
  servings: number,
  alreadyPromisedForDate: number,
): string | null {
  if (rules.minServings !== null && servings < rules.minServings) return `This package needs at least ${String(rules.minServings)} servings.`;
  if (rules.maxServings !== null && servings > rules.maxServings) return `This package allows at most ${String(rules.maxServings)} servings in one order.`;
  if (fulfilment === null) return rules.noticeMinutes !== null || rules.closesDaysBefore !== null || rules.weekdays.length > 0 || rules.dailyLimit !== null ? 'Choose the date you need it.' : null;
  const gap = (dayNumber(fulfilment.date) - dayNumber(now.date)) * 1440 + (fulfilment.minute - now.minute);
  if (gap < 0) return 'Choose a date that has not passed.';
  if (rules.weekdays.length > 0 && !rules.weekdays.includes(weekday(fulfilment.date))) return 'This package is not available on that day of the week.';
  if (rules.noticeMinutes !== null && gap < rules.noticeMinutes) {
    const hours = rules.noticeMinutes / 60;
    return `This package needs ${Number.isInteger(hours) ? String(hours) : hours.toFixed(1)} hour${hours === 1 ? '' : 's'} notice.`;
  }
  if (rules.closesDaysBefore !== null) {
    const closesAt = (dayNumber(fulfilment.date) - rules.closesDaysBefore) * 1440 + (rules.closesAtMinute ?? 0);
    if (dayNumber(now.date) * 1440 + now.minute > closesAt) return `Orders for that date closed ${rules.closesDaysBefore === 0 ? 'on the day' : `${String(rules.closesDaysBefore)} day${rules.closesDaysBefore === 1 ? '' : 's'} before`} at ${clock(rules.closesAtMinute ?? 0)}.`;
  }
  if (rules.dailyLimit !== null && alreadyPromisedForDate + servings > rules.dailyLimit) {
    const left = Math.max(0, rules.dailyLimit - alreadyPromisedForDate);
    return left === 0 ? 'This package is fully booked for that date.' : `Only ${String(left)} serving${left === 1 ? '' : 's'} left for that date.`;
  }
  return null;
}
