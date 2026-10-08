/** The parts of a quote line that turning it into an order line needs. */
export interface QuoteLineForOrder {
  productId: string | null;
  quantity: string;
  lineAmount: string;
  isGift: boolean;
}

const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * An order has one line per product. A gift of something that was also bought is folded into the
 * bought line (more units, the same amount), the same way an order folds the parts of a kit into
 * a product bought on its own. A line that is still a gift after folding stays a gift.
 */
export function mergeLinesForOrder<T extends QuoteLineForOrder>(lines: T[]): T[] {
  const out: T[] = [];
  for (const line of lines) {
    const same = line.productId ? out.find((o) => o.productId === line.productId) : undefined;
    if (!same) {
      out.push({ ...line });
      continue;
    }
    same.quantity = (Number(same.quantity) + Number(line.quantity)).toFixed(3);
    same.lineAmount = money(Number(same.lineAmount) + Number(line.lineAmount)).toFixed(2);
    same.isGift = same.isGift && line.isGift;
  }
  return out;
}
