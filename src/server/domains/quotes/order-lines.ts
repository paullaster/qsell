/** The parts of a quote line that turning it into an order line needs. */
export interface QuoteLineForOrder {
  productId: string | null;
  quantity: string;
  lineAmount: string;
  isGift: boolean;
  unitId?: string | null;
  unitCode?: string | null;
  enteredQuantity?: number | null;
  qtyPerUnit?: string | null;
  enteredUnitPrice?: string | null;
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
    // Two lines of one product are one order line. Typed in the same unit they stay in it, with the
    // typed amounts added up; typed in different units they are shown in the product's base unit.
    if (same.unitId === line.unitId && same.enteredQuantity != null && line.enteredQuantity != null) {
      same.enteredQuantity = Math.round((same.enteredQuantity + line.enteredQuantity) * 1000) / 1000;
      same.enteredUnitPrice = null;
    } else if (same.enteredQuantity != null || line.enteredQuantity != null) {
      same.enteredQuantity = null;
      same.qtyPerUnit = null;
      same.enteredUnitPrice = null;
      same.unitId = null;
      same.unitCode = null;
    }
  }
  return out;
}
