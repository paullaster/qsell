import { effectiveStandardPrice } from '@/lib/standard-price';
import { kitCost, kitTax, type KitTaxShape } from '@/server/domains/pricing/domain/kits';

/** One line as the totals see it. */
export interface TotalsLine {
  productId: string;
  quantity: number;
  /** The price per unit; the product's own price when not given. */
  unitPrice?: number;
  /** The section the line sits in, if any, so section totals can be given. */
  sectionId?: string | null;
  discountPercent: number;
  /** The unit `quantity` and `unitPrice` are typed in (one of the product's own); the base unit when left out. */
  unitId?: string | null;
  /** What the line is worth before discounts when a price was typed per unit: that price times the typed quantity, exactly. */
  exactAmount?: number;
}

/** What the totals need to know about a product. */
export interface TotalsProduct {
  price?: number;
  standardPrice?: number | null;
  costPrice: number;
  taxRate?: number;
  isTaxInclusive?: boolean;
}

export interface LineTotals {
  net: number;
  tax: number;
  total: number;
  cost: number;
  grossProfit: number;
  grossMarginPercent: number;
  /** This line's margin is below the floor the company has set. */
  belowFloor: boolean;
}

export interface QuoteTotals {
  lines: LineTotals[];
  /** What each section's lines come to (net plus tax), by section id. */
  sectionTotals: Record<string, number>;
  /** Net of tax, before shipping. */
  subtotal: number;
  tax: number;
  /** What the customer pays: net plus tax plus shipping. */
  total: number;
  cost: number;
  grossProfit: number;
  marginPercent: number;
  /** The margin is below the floor the company has set. */
  belowFloor: boolean;
  /** The floor it was measured against, in percent. */
  minimumMarginPercent: number;
}

/**
 * What a quote comes to, line by line and in all: net, tax, cost and margin. A kit is taxed and
 * costed from what is in it, as it is when the quote is saved. This is the working that the
 * editor shows while a quote is typed; saving works it out again on its own.
 */
export function computeQuoteTotals(
  input: { lines: TotalsLine[]; discountPercent: number; shippingFee: number },
  products: ReadonlyMap<string, TotalsProduct>,
  kits: ReadonlyMap<string, KitTaxShape>,
  minimumMargin: number,
): QuoteTotals {
  const lines = input.lines.map((line): LineTotals => {
    const product = products.get(line.productId);
    const unit = line.unitPrice ?? (product === undefined ? null : effectiveStandardPrice(product)) ?? 0;
    const discount = (1 - line.discountPercent / 100) * (1 - input.discountPercent / 100);
    const gross = (line.exactAmount ?? unit * line.quantity) * discount;
    const rate = product?.taxRate ?? 0;
    const inclusive = product?.isTaxInclusive !== false;
    const kit = kits.get(line.productId);
    const split = kit
      ? kitTax(gross, line.quantity, kit, inclusive)
      : {
          net: inclusive && rate > 0 ? gross / (1 + rate / 100) : gross,
          tax: inclusive && rate > 0 ? gross - gross / (1 + rate / 100) : (gross * rate) / 100,
        };
    const unitCost = kit ? kitCost(kit) : (product?.costPrice ?? 0);
    const cost = unitCost * line.quantity;
    const grossProfit = split.net - cost;
    const grossMarginPercent = split.net > 0 ? (grossProfit / split.net) * 100 : 0;
    return {
      net: split.net,
      tax: split.tax,
      total: split.net + split.tax,
      cost,
      grossProfit,
      grossMarginPercent,
      belowFloor: grossMarginPercent < minimumMargin,
    };
  });
  const sum = (pick: (line: LineTotals) => number) =>
    lines.reduce((total, line) => total + pick(line), 0);
  const subtotal = sum((line) => line.net);
  const tax = sum((line) => line.tax);
  const cost = sum((line) => line.cost);
  const grossProfit = subtotal - cost;
  const marginPercent = subtotal > 0 ? (grossProfit / subtotal) * 100 : 0;
  const sectionTotals: Record<string, number> = {};
  input.lines.forEach((line, index) => {
    if (line.sectionId === undefined || line.sectionId === null) return;
    sectionTotals[line.sectionId] =
      (sectionTotals[line.sectionId] ?? 0) + (lines[index]?.total ?? 0);
  });
  return {
    lines,
    sectionTotals,
    subtotal,
    tax,
    total: subtotal + tax + (Number.isFinite(input.shippingFee) ? input.shippingFee : 0),
    cost,
    grossProfit,
    marginPercent,
    belowFloor: marginPercent < minimumMargin,
    minimumMarginPercent: minimumMargin,
  };
}
