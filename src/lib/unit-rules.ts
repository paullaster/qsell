import {
  DECIMAL_SCALE,
  divideRounded,
  formatDecimal,
  parseDecimal,
  quantityFits,
} from '@/lib/decimal';
import { has, trimToNull } from '@/lib/values';

/** The families a unit belongs to. Units of one family convert into each other by their factors; packaging does not (it is set per product). */
export const UNIT_KINDS = [
  { id: 'count', label: 'Count', hint: 'Pieces, dozens, pairs' },
  { id: 'mass', label: 'Mass / weight', hint: 'Kilograms, grams, tonnes' },
  { id: 'volume', label: 'Volume', hint: 'Litres, millilitres' },
  { id: 'length', label: 'Length', hint: 'Metres, centimetres' },
  { id: 'area', label: 'Area', hint: 'Square metres' },
  { id: 'time', label: 'Time', hint: 'Hours, days' },
  {
    id: 'packaging',
    label: 'Packaging',
    hint: 'Box, crate, bag: what it holds is set per product',
  },
] as const;

export type UnitKind = (typeof UNIT_KINDS)[number]['id'];

export const isUnitKind = (value: string): value is UnitKind =>
  UNIT_KINDS.some((k) => k.id === value);
export const unitKindLabel = (kind: string): string =>
  UNIT_KINDS.find((k) => k.id === kind)?.label ?? kind;

export const MAX_DECIMALS = 3;
const CODE = /^[A-Z0-9][A-Z0-9._-]{0,19}$/;
const INTERNATIONAL = /^[A-Z0-9]{2,3}$/;
const ETIMS = /^[A-Z0-9]{1,5}$/;

/** What a unit is, as typed (text fields) or as saved. */
export interface UnitFields {
  code: string;
  name: string;
  description: string | null;
  symbol: string | null;
  kind: UnitKind;
  /** The unit this one is a multiple of; null for the base of its family (and for packaging). */
  baseUnitId: string | null;
  /** How many of the base unit make one of this unit. Always "1" for a base. */
  factorToBase: string;
  /** Digits after the point that a quantity in this unit may have. */
  decimals: number;
  /** UN/ECE Recommendation 20 code, the one e-invoicing and customs use. */
  internationalCode: string | null;
  /** KRA eTIMS quantity unit code. */
  etimsCode: string | null;
}

export interface UnitDraft {
  code: string;
  name: string;
  description: string;
  symbol: string;
  kind: string;
  baseUnitId: string;
  factorToBase: string;
  decimals: string;
  internationalCode: string;
  etimsCode: string;
}

export const emptyUnitDraft = (): UnitDraft => ({
  code: '',
  name: '',
  description: '',
  symbol: '',
  kind: 'count',
  baseUnitId: '',
  factorToBase: '1',
  decimals: '0',
  internationalCode: '',
  etimsCode: '',
});

export function draftFromUnit(unit: UnitFields): UnitDraft {
  return {
    code: unit.code,
    name: unit.name,
    description: unit.description ?? '',
    symbol: unit.symbol ?? '',
    kind: unit.kind,
    baseUnitId: unit.baseUnitId ?? '',
    factorToBase: unit.factorToBase,
    decimals: String(unit.decimals),
    internationalCode: unit.internationalCode ?? '',
    etimsCode: unit.etimsCode ?? '',
  };
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** The factor as a clean decimal text ("0.001"), or why it cannot be one. */
export function cleanFactor(text: string, what = 'The conversion factor'): Checked<string> {
  const scaled = parseDecimal(text);
  if (scaled === null || text.trim().startsWith('-'))
    return {
      ok: false,
      error: `${what} must be a positive number with at most ${String(DECIMAL_SCALE)} decimals.`,
    };
  if (scaled <= 0n) return { ok: false, error: `${what} must be more than zero.` };
  return { ok: true, value: trimmedDecimal(scaled) };
}

/** A scaled number as the shortest text ("12", "0.001"). */
export function trimmedDecimal(scaled: bigint): string {
  const text = formatDecimal(scaled);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/**
 * The one check of a unit, used by the form (for convenience) and again by the server (for real).
 * It looks at the unit alone; whether the base unit exists and is of the same family is the server's to know.
 */
export function checkUnit(draft: UnitDraft): Checked<UnitFields> {
  const code = draft.code.trim().toUpperCase();
  if (!CODE.test(code))
    return {
      ok: false,
      error:
        'The code is 1 to 20 letters, digits, dots, dashes or underscores, starting with a letter or digit (for example KG).',
    };
  const name = draft.name.trim();
  if (name.length < 1 || name.length > 80)
    return { ok: false, error: 'The name is 1 to 80 characters long.' };
  const description = trimToNull(draft.description);
  if (description !== null && description.length > 200)
    return { ok: false, error: 'The description is at most 200 characters.' };
  const symbol = trimToNull(draft.symbol);
  if (symbol !== null && symbol.length > 12)
    return { ok: false, error: 'The symbol is at most 12 characters.' };
  if (!isUnitKind(draft.kind)) return { ok: false, error: 'Choose the kind of unit.' };
  const decimals = Number(draft.decimals);
  if (
    draft.decimals.trim() === '' ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_DECIMALS
  )
    return { ok: false, error: `Decimals is a whole number from 0 to ${String(MAX_DECIMALS)}.` };
  const international = trimToNull(draft.internationalCode)?.toUpperCase() ?? null;
  if (international !== null && !INTERNATIONAL.test(international))
    return {
      ok: false,
      error: 'The international (UN/ECE) code is 2 or 3 letters or digits, for example KGM.',
    };
  const etims = trimToNull(draft.etimsCode)?.toUpperCase() ?? null;
  if (etims !== null && !ETIMS.test(etims))
    return { ok: false, error: 'The eTIMS code is 1 to 5 letters or digits.' };

  const baseUnitId = has(draft.baseUnitId) ? draft.baseUnitId : null;
  let factorToBase = '1';
  if (baseUnitId !== null) {
    if (draft.kind === 'packaging')
      return {
        ok: false,
        error: 'A packaging unit has no base unit: what it holds is set on each product.',
      };
    const factor = cleanFactor(draft.factorToBase);
    if (!factor.ok) return factor;
    factorToBase = factor.value;
  }
  return {
    ok: true,
    value: {
      code,
      name,
      description,
      symbol,
      kind: draft.kind,
      baseUnitId,
      factorToBase,
      decimals,
      internationalCode: international,
      etimsCode: etims,
    },
  };
}

/** A quantity in one unit written in another of the same family, rounded to the target's decimals; null if a number is not valid. */
export function convertQuantity(
  quantity: string,
  fromFactor: string,
  toFactor: string,
  toDecimals: number,
): string | null {
  const q = parseDecimal(quantity);
  const from = parseDecimal(fromFactor);
  const to = parseDecimal(toFactor);
  if (q === null || from === null || to === null || to <= 0n || from <= 0n) return null;
  return formatDecimal(divideRounded(q * from, to), toDecimals);
}

/** How many base units a quantity of a packaging unit is, given what one of it holds ("1 CRATE = 20 KG"). */
export function toBaseQuantity(
  quantity: string,
  basePerUnit: string,
  baseDecimals: number,
): string | null {
  const q = parseDecimal(quantity);
  const per = parseDecimal(basePerUnit);
  if (q === null || per === null || per <= 0n) return null;
  return formatDecimal(divideRounded(q * per, 10n ** BigInt(DECIMAL_SCALE)), baseDecimals);
}

/** What a unit's change would alter in the meaning of quantities already saved. */
export const MEANING_FIELDS = ['kind', 'baseUnitId', 'factorToBase'] as const;

export function changesMeaning(before: UnitFields, after: UnitFields): boolean {
  return (
    before.kind !== after.kind ||
    before.baseUnitId !== after.baseUnitId ||
    parseDecimal(before.factorToBase) !== parseDecimal(after.factorToBase)
  );
}

/** One sentence on where a unit is used, or null when nowhere. */
export interface UnitUsage {
  products: number;
  packagings: number;
  derivedUnits: number;
  /** Quote, order, credit note and return lines entered in this unit. */
  documentLines: number;
}

export const NO_USAGE: UnitUsage = {
  products: 0,
  packagings: 0,
  derivedUnits: 0,
  documentLines: 0,
};

export const isUsed = (usage: UnitUsage): boolean =>
  usage.products + usage.packagings + usage.derivedUnits + usage.documentLines > 0;

export function usageWords(usage: UnitUsage): string | null {
  const parts: string[] = [];
  const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;
  if (usage.products > 0) parts.push(plural(usage.products, 'product', 'products'));
  if (usage.packagings > 0)
    parts.push(plural(usage.packagings, 'product packaging', 'product packagings'));
  if (usage.derivedUnits > 0) parts.push(plural(usage.derivedUnits, 'other unit', 'other units'));
  if (usage.documentLines > 0)
    parts.push(plural(usage.documentLines, 'document line', 'document lines'));
  return parts.length === 0 ? null : `Used by ${parts.join(', ')}`;
}

/** One alternate unit of a product as typed. */
export interface PackagingDraft {
  unitId: string;
  qtyPerBase: string;
  weightKg: string;
  isSalesDefault: boolean;
  isPurchaseDefault: boolean;
}

export interface PackagingFields {
  unitId: string;
  qtyPerBase: string;
  weightKg: string | null;
  isSalesDefault: boolean;
  isPurchaseDefault: boolean;
}

export const MAX_PACKAGINGS = 20;

/** A product's alternate units, checked on their own (the server also checks that the units exist and are on). */
export function checkPackagings(
  drafts: readonly PackagingDraft[],
  baseUnitId: string,
): Checked<PackagingFields[]> {
  if (drafts.length > MAX_PACKAGINGS)
    return {
      ok: false,
      error: `A product can have at most ${String(MAX_PACKAGINGS)} alternate units.`,
    };
  const seen = new Set<string>();
  const rows: PackagingFields[] = [];
  for (const draft of drafts) {
    if (!has(draft.unitId))
      return { ok: false, error: 'Choose a unit for every alternate unit row.' };
    if (draft.unitId === baseUnitId)
      return {
        ok: false,
        error: 'The base unit is already the product’s unit; choose a different one.',
      };
    if (seen.has(draft.unitId))
      return { ok: false, error: 'A unit can be listed only once for a product.' };
    seen.add(draft.unitId);
    const qty = cleanFactor(draft.qtyPerBase, 'How many base units it holds');
    if (!qty.ok) return qty;
    const weight = draft.weightKg.trim();
    let weightKg: string | null = null;
    if (weight !== '') {
      const scaled = parseDecimal(weight);
      if (scaled === null || scaled < 0n || !/^\d{1,8}(\.\d{1,4})?$/.test(weight))
        return {
          ok: false,
          error: 'The shipping weight is a number of kg with at most 4 decimals.',
        };
      weightKg = trimmedDecimal(scaled);
    }
    rows.push({
      unitId: draft.unitId,
      qtyPerBase: qty.value,
      weightKg,
      isSalesDefault: draft.isSalesDefault,
      isPurchaseDefault: draft.isPurchaseDefault,
    });
  }
  if (rows.filter((r) => r.isSalesDefault).length > 1)
    return { ok: false, error: 'Only one unit can be the default for selling.' };
  if (rows.filter((r) => r.isPurchaseDefault).length > 1)
    return { ok: false, error: 'Only one unit can be the default for buying.' };
  return { ok: true, value: rows };
}

/** Why a quantity cannot be counted in a unit, in words for the person; null when it can. `what` names the thing counted. */
export function quantityProblem(
  value: number,
  decimals: number,
  unitName: string,
  what: string,
): string | null {
  if (!Number.isFinite(value)) return `${what} must be a number.`;
  if (quantityFits(value, decimals)) return null;
  return decimals === 0
    ? `${what} must be a whole number: it is counted in ${unitName}.`
    : `${what} can have at most ${String(decimals)} ${decimals === 1 ? 'decimal' : 'decimals'}: it is counted in ${unitName}.`;
}

/** The smallest step of a quantity input for a unit with this many decimals ("1", "0.1", "0.01", "0.001"). */
export const quantityStep = (decimals: number): string =>
  decimals <= 0 ? '1' : `0.${'0'.repeat(Math.min(decimals, 3) - 1)}1`;

/** What one line of a quote or order comes to in the product's base unit, when it was typed in another unit of the product. */
export function lineInBase(
  entered: number,
  qtyPerUnit: string,
  baseDecimals: number,
): Checked<number> {
  if (!Number.isFinite(entered) || entered <= 0)
    return { ok: false, error: 'The quantity must be above zero.' };
  const base = toBaseQuantity(entered.toFixed(3), qtyPerUnit, 3);
  if (base === null) return { ok: false, error: 'The unit conversion is not valid.' };
  const quantity = Number(base);
  if (!quantityFits(quantity, baseDecimals))
    return {
      ok: false,
      error: `That comes to ${base} in the base unit, which allows only ${String(baseDecimals)} ${baseDecimals === 1 ? 'decimal' : 'decimals'}.`,
    };
  return { ok: true, value: quantity };
}

/** What a document line shows: the quantity and unit as they were typed, and the price per that unit. */
export interface LineForDisplay {
  quantity: number;
  unitPrice: number;
  /** What the whole line comes to, used to work out a price per unit when none was kept. */
  total: number;
  unitCode?: string | null;
  enteredQuantity?: number | null;
  enteredUnitPrice?: number | null;
}

export function lineDisplay(line: LineForDisplay): {
  quantity: number;
  unit: string | null;
  unitPrice: number;
} {
  const unit = has(line.unitCode) ? line.unitCode : null;
  if (
    line.enteredQuantity === null ||
    line.enteredQuantity === undefined ||
    line.enteredQuantity <= 0
  ) {
    return { quantity: line.quantity, unit, unitPrice: line.unitPrice };
  }
  const price =
    line.enteredUnitPrice ?? Math.round((line.total / line.enteredQuantity) * 100) / 100;
  return { quantity: line.enteredQuantity, unit, unitPrice: price };
}

/** "3 crate", "2.5 kg" or just "12" for a line. */
export function quantityWords(line: LineForDisplay): string {
  const shown = lineDisplay(line);
  return shown.unit === null ? String(shown.quantity) : `${String(shown.quantity)} ${shown.unit}`;
}

/** A saved line (quote or order, numbers possibly as text) in the shape the display helpers take. */
export function lineFromRow(row: {
  quantity: string | number;
  unitPrice: string | number;
  lineAmount?: string | number;
  totalPrice?: string | number;
  unitCode?: string | null;
  enteredQuantity?: number | null;
  enteredUnitPrice?: string | number | null;
}): LineForDisplay {
  return {
    quantity: Number(row.quantity),
    unitPrice: Number(row.unitPrice),
    total: Number(row.lineAmount ?? row.totalPrice ?? 0),
    unitCode: row.unitCode,
    enteredQuantity: row.enteredQuantity,
    enteredUnitPrice: row.enteredUnitPrice == null ? null : Number(row.enteredUnitPrice),
  };
}
