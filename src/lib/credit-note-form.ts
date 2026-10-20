import { creditInBase, type SoldProduct } from '@/lib/credit-units';
import { roundQty } from '@/lib/decimal';
import { quantityStep } from '@/lib/unit-rules';

/**
 * Issuing a credit note against an order: reasons and their words, the credit estimate and what the
 * form sends. Pure. The server prices and checks everything again.
 */
export const CREDIT_NOTE_REASON_LABEL: Record<string, string> = {
  returned_goods: 'Goods returned',
  damaged_goods: 'Damaged goods',
  pricing_error: 'Pricing error',
  order_cancelled: 'Order cancelled',
  goodwill: 'Goodwill',
  other: 'Other (explain below)',
};

export const reasonLabel = (code: string): string => (Object.hasOwn(CREDIT_NOTE_REASON_LABEL, code) ? CREDIT_NOTE_REASON_LABEL[code] : code);

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export const formatMoney = (n: number, currency: string): string => `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface CreditableLine {
  productId: string;
  description?: string;
  unitPrice: number;
  remainingQuantity: number;
  remainingAmount: number;
  /** The unit the goods were sold in; credit can be given in it. Absent when sold in the base unit. */
  unit?: { id: string; code: string; qtyPerUnit: string } | null;
  /** What the product's base unit allows and is called (whole numbers when not known). */
  baseDecimals?: number;
  baseUnitName?: string;
}

export interface ChosenLine<L extends CreditableLine = CreditableLine> {
  line: L;
  /** As typed, in the line's credit unit. */
  quantity: number;
  /** What it comes to in base units: what the invoice, stock and the limits count in. */
  base: number;
  /** Why it cannot be credited as typed, in words; null when it can. */
  problem: string | null;
}

/** How many base units one of the line's credit unit holds (1 when it is credited in the base unit). */
export const perUnit = (line: CreditableLine): number => (line.unit == null ? 1 : Number(line.unit.qtyPerUnit));

/** What a quantity of base units is in the unit the line is credited in. */
export const inCreditUnit = (line: CreditableLine, base: number): number => roundQty(base / perUnit(line));

/** The unit the line is credited in, as words ("crate" or the base unit's name). */
export const creditUnitName = (line: CreditableLine): string => line.unit?.code ?? line.baseUnitName ?? '';

/** The smallest step a person can type for the line (a crate credited in whole crates, a kilogram line in grams). */
export const creditStep = (line: CreditableLine): string => (line.unit == null ? quantityStep(line.baseDecimals ?? 0) : '0.001');

/** The lines with something typed. A part unit is fine where the unit allows it; otherwise the line carries the reason. */
export function chosenLines<L extends CreditableLine>(lines: readonly L[], qty: Readonly<Record<string, string>>): ChosenLine<L>[] {
  return lines
    .map((line) => {
      const typed = Number(Object.hasOwn(qty, line.productId) ? qty[line.productId] : 0);
      const quantity = Number.isFinite(typed) && typed > 0 ? typed : 0;
      const checked = quantity > 0 ? creditInBase(toSold(line), { productId: line.productId, quantity, unitId: line.unit?.id }) : null;
      const base = checked?.ok === true ? checked.value.base : quantity;
      let problem: string | null = null;
      if (checked?.ok === false) problem = checked.error;
      else if (base > line.remainingQuantity) problem = `Only ${[String(inCreditUnit(line, line.remainingQuantity)), creditUnitName(line)].filter((w) => w !== '').join(' ')} left to credit.`;
      return { line, quantity, base, problem };
    })
    .filter((x) => x.quantity > 0);
}

const toSold = (line: CreditableLine): SoldProduct => ({
  productId: line.productId,
  description: line.description ?? 'This item',
  quantity: line.remainingQuantity,
  unitPrice: line.unitPrice,
  amount: line.remainingAmount,
  unit: line.unit ?? null,
  baseDecimals: line.baseDecimals ?? 0,
  baseUnitName: line.baseUnitName ?? 'its unit',
  lines: 1,
});

/** The credit total. The last unit takes whatever is left, exactly as the server prices it. */
export function creditEstimate(chosen: readonly ChosenLine[]): number {
  return round2(chosen.reduce((sum, { line, base }) => sum + (base === line.remainingQuantity ? line.remainingAmount : round2(line.unitPrice * base)), 0));
}

export const noteMissing = (reason: string | null, note: string): boolean => reason === 'other' && note.trim() === '';

export const anythingLeft = (lines: readonly CreditableLine[]): boolean => lines.some((l) => l.remainingQuantity > 0);

export function creditNoteRequest(orderId: string, chosen: readonly ChosenLine[], reason: string, note: string, restock: boolean, canRestock: boolean) {
  const text = note.trim();
  return {
    orderId,
    lines: chosen.map(({ line, quantity }) => ({ productId: line.productId, quantity, ...(line.unit == null ? {} : { unitId: line.unit.id }) })),
    reasonCode: reason,
    reasonNote: text === '' ? undefined : text,
    restock: restock && canRestock,
  };
}
