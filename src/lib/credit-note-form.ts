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
  unitPrice: number;
  remainingQuantity: number;
  remainingAmount: number;
}

export interface ChosenLine<L extends CreditableLine = CreditableLine> {
  line: L;
  quantity: number;
}

/** The lines with a whole number of units typed. */
export function chosenLines<L extends CreditableLine>(lines: readonly L[], qty: Readonly<Record<string, string>>): ChosenLine<L>[] {
  return lines
    .map((line) => ({ line, quantity: Math.floor(Number(Object.hasOwn(qty, line.productId) ? qty[line.productId] : 0)) }))
    .filter((x) => x.quantity > 0);
}

/** The credit total. The last unit takes whatever is left, exactly as the server prices it. */
export function creditEstimate(chosen: readonly ChosenLine[]): number {
  return round2(chosen.reduce((sum, { line, quantity }) => sum + (quantity === line.remainingQuantity ? line.remainingAmount : round2(line.unitPrice * quantity)), 0));
}

export const noteMissing = (reason: string | null, note: string): boolean => reason === 'other' && note.trim() === '';

export const anythingLeft = (lines: readonly CreditableLine[]): boolean => lines.some((l) => l.remainingQuantity > 0);

export function creditNoteRequest(orderId: string, chosen: readonly ChosenLine[], reason: string, note: string, restock: boolean, canRestock: boolean) {
  const text = note.trim();
  return {
    orderId,
    lines: chosen.map(({ line, quantity }) => ({ productId: line.productId, quantity })),
    reasonCode: reason,
    reasonNote: text === '' ? undefined : text,
    restock: restock && canRestock,
  };
}
