import { KIT_ALLOCATIONS } from '@/server/domains/pricing/domain/kits';
import type { PackagePricingMode, ShortStockMode } from '@/server/domains/pricing/domain/packages';

export interface PackageChoice {
  id: string;
  label: string;
}

export const PACKAGE_PRICING_CHOICES: (PackageChoice & { id: PackagePricingMode })[] = [
  { id: 'base_plus_differences', label: 'One base price, plus a difference for each option (usual)' },
  { id: 'summed', label: 'Each option priced on its own and added up' },
];

export const PACKAGE_SHORT_STOCK_CHOICES: (PackageChoice & { id: ShortStockMode })[] = [
  { id: 'hide', label: 'Hide it (usual)' },
  { id: 'disable', label: 'Show it greyed out, saying it is sold out' },
  { id: 'substitute', label: 'Show it greyed out and suggest another' },
];

export const PACKAGE_SPLIT_CHOICES: PackageChoice[] = KIT_ALLOCATIONS.map((a) => ({ id: a.value, label: a.label }));

export const labelOfPackageChoice = (choices: readonly PackageChoice[], id: string): string => choices.find((c) => c.id === id)?.label ?? id;

export const PACKAGE_AUDIENCE_CHOICES: PackageChoice[] = [
  { id: 'anyone', label: 'Anyone' },
  { id: 'signed_in', label: 'Signed-in customers only' },
  { id: 'groups', label: 'Only customers in the groups I choose' },
];

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** "10:30" to minutes after midnight, or null when it is not a time. */
export function minutesOfTime(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (m === null) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[1]) < 24 && Number(m[2]) < 60 ? minutes : null;
}

/** Minutes after midnight as "10:30". */
export const timeOfMinutes = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

function servingsWords(least: number | null, most: number | null): string {
  if (least !== null && most !== null) return `${String(least)} to ${String(most)} servings`;
  if (least !== null) return `From ${String(least)} servings`;
  return most === null ? '' : `Up to ${String(most)} servings`;
}

/** The rules of a package in a few plain words for the list, or an empty list when it has none. */
export function rulesWords(rules: { minServings: number | null; maxServings: number | null; noticeMinutes: number | null; closesDaysBefore: number | null; closesAtMinute: number | null; weekdays: number[]; dailyLimit: number | null; audience: string }): string[] {
  const out: string[] = [];
  const servings = servingsWords(rules.minServings, rules.maxServings);
  if (servings !== '') out.push(servings);
  if (rules.noticeMinutes !== null) out.push(`${rules.noticeMinutes % 60 === 0 ? String(rules.noticeMinutes / 60) : (rules.noticeMinutes / 60).toFixed(1)} h notice`);
  if (rules.closesDaysBefore !== null && rules.closesAtMinute !== null) out.push(`Closes ${rules.closesDaysBefore === 0 ? 'on the day' : `${String(rules.closesDaysBefore)} day${rules.closesDaysBefore === 1 ? '' : 's'} before`} at ${timeOfMinutes(rules.closesAtMinute)}`);
  if (rules.weekdays.length > 0) out.push(rules.weekdays.map((d) => (WEEKDAY_NAMES[d] ?? '').slice(0, 3)).join(', '));
  if (rules.dailyLimit !== null) out.push(`${String(rules.dailyLimit)} servings a day`);
  if (rules.audience === 'signed_in') out.push('Signed-in only');
  if (rules.audience === 'groups') out.push('Chosen groups only');
  return out;
}

export const PACKAGE_SLOT_SOURCE_CHOICES: PackageChoice[] = [
  { id: 'list', label: 'A list I make, product by product' },
  { id: 'category', label: 'Every product of a category (new ones appear by themselves)' },
];

/** The most products a slot filled from a category offers; past it the first by name are shown. */
export const CATEGORY_SLOT_LIMIT = 100;
