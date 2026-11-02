export interface TaxSplit {
  /** The charge before tax: what is kept as the order's shipping fee. */
  net: number;
  tax: number;
  /** What the customer pays for delivery. */
  gross: number;
}

const cents = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Splits a delivery charge into what is charged and the tax on it. A charge quoted without tax has tax added; one quoted
 * with tax included keeps its amount and has the tax taken out of it. To the cent, so net plus tax is always the gross.
 */
export function splitTax(amount: number, ratePercent: number, inclusive: boolean): TaxSplit {
  const rate = Number.isFinite(ratePercent) && ratePercent > 0 ? ratePercent : 0;
  if (rate === 0) return { net: cents(amount), tax: 0, gross: cents(amount) };
  if (inclusive) {
    const gross = cents(amount);
    const net = cents(gross / (1 + rate / 100));
    return { net, tax: cents(gross - net), gross };
  }
  const net = cents(amount);
  const tax = cents((net * rate) / 100);
  return { net, tax, gross: cents(net + tax) };
}
