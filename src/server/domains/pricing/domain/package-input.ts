import { PACKAGE_LIMITS, PRICING_MODES, type ShortStockMode } from './packages';
import type { KitAllocation } from './kits';
import { rulesProblem, type PackageInput, type PackageRules } from '../package-service';

/**
 * Reads what the screen sent (untrusted) into a package definition. It only fixes the shapes: strings are trimmed and bounded,
 * numbers must be finite, lists are bounded. Whether the package makes sense is decided by `checkPackage` on the server.
 */
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const SHORT: readonly ShortStockMode[] = ['hide', 'disable', 'substitute'];
const SPLIT: readonly KitAllocation[] = ['list_price', 'cost', 'explicit'];

const wholeOrNull = (value: unknown): number | null => (value === undefined || value === null || value === '' ? null : num(value));

/** The rules the screen sent; null when none were sent (leave them as they are), or an error in plain words. */
function parseRules(raw: unknown): { ok: true; rules: PackageRules | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, rules: undefined };
  const r = obj(raw);
  const numbers = [r.minServings, r.maxServings, r.noticeMinutes, r.closesDaysBefore, r.closesAtMinute, r.dailyLimit];
  if (numbers.some((n) => n !== undefined && n !== null && n !== '' && num(n) === null)) return { ok: false, error: 'A rule needs a number.' };
  const audience = r.audience === 'signed_in' || r.audience === 'groups' ? r.audience : 'anyone';
  const rules: PackageRules = {
    minServings: wholeOrNull(r.minServings),
    maxServings: wholeOrNull(r.maxServings),
    noticeMinutes: wholeOrNull(r.noticeMinutes),
    closesDaysBefore: wholeOrNull(r.closesDaysBefore),
    closesAtMinute: wholeOrNull(r.closesAtMinute),
    weekdays: list(r.weekdays).flatMap((d) => (typeof d === 'number' && Number.isInteger(d) ? [d] : [])).slice(0, 7),
    dailyLimit: wholeOrNull(r.dailyLimit),
    audience,
    groupIds: list(r.groupIds).flatMap((g) => (typeof g === 'string' && g.length > 0 && g.length <= 100 ? [g] : [])).slice(0, 50),
  };
  const wrong = rulesProblem(rules);
  return wrong === null ? { ok: true, rules } : { ok: false, error: wrong };
}

export type ParsedPackage = { ok: true; input: PackageInput } | { ok: false; error: string };

export function parsePackageInput(raw: unknown): ParsedPackage {
  const i = obj(raw);
  const productId = text(i.productId, 200);
  if (productId === '') return { ok: false, error: 'Choose the product that is sold as the package.' };
  const pricingMode = PRICING_MODES.find((m) => m === i.pricingMode);
  if (pricingMode === undefined) return { ok: false, error: 'Choose how the package is priced.' };
  const allocation = SPLIT.find((m) => m === i.allocation);
  if (allocation === undefined) return { ok: false, error: 'Choose how the price is split over the parts.' };
  const shortStockMode = SHORT.find((m) => m === i.shortStockMode);
  if (shortStockMode === undefined) return { ok: false, error: 'Choose what to do with an option that is out of stock.' };
  const slotsRaw = list(i.slots);
  if (slotsRaw.length > PACKAGE_LIMITS.slots) return { ok: false, error: `A package can have at most ${String(PACKAGE_LIMITS.slots)} slots.` };
  const slots: PackageInput['slots'] = [];
  for (const [si, slotRaw] of slotsRaw.entries()) {
    const slot = obj(slotRaw);
    const optionsRaw = list(slot.options);
    if (optionsRaw.length > PACKAGE_LIMITS.optionsPerSlot) return { ok: false, error: `A slot can have at most ${String(PACKAGE_LIMITS.optionsPerSlot)} options.` };
    const minPicks = num(slot.minPicks);
    const maxPicks = num(slot.maxPicks);
    if (minPicks === null || maxPicks === null) return { ok: false, error: `Slot ${String(si + 1)}: give the least and the most picks.` };
    const options: PackageInput['slots'][number]['options'] = [];
    for (const [oi, optionRaw] of optionsRaw.entries()) {
      const option = obj(optionRaw);
      const quantity = num(option.quantity);
      if (quantity === null) return { ok: false, error: `Slot ${String(si + 1)}, option ${String(oi + 1)}: give a quantity.` };
      const difference = option.difference === undefined || option.difference === null ? 0 : num(option.difference);
      const ownPrice = option.ownPrice === undefined || option.ownPrice === null ? null : num(option.ownPrice);
      const weight = option.weight === undefined || option.weight === null ? null : num(option.weight);
      if (difference === null || (option.ownPrice !== undefined && option.ownPrice !== null && ownPrice === null) || (option.weight !== undefined && option.weight !== null && weight === null)) {
        return { ok: false, error: `Slot ${String(si + 1)}, option ${String(oi + 1)}: a number is not valid.` };
      }
      options.push({ productId: text(option.productId, 200), quantity, difference, ownPrice, isDefault: option.isDefault === true, weight });
    }
    slots.push({ name: text(slot.name, 80), helpText: text(slot.helpText, 200), minPicks, maxPicks, allowRepeats: slot.allowRepeats === true, included: slot.included === true, options });
  }
  const parsed = parseRules(i.rules);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, input: { productId, pricingMode, allocation, shortStockMode, isActive: i.isActive !== false, ...(parsed.rules === undefined ? {} : { rules: parsed.rules }), slots } };
}
