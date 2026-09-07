/**
 * Shared storefront + server order pricing.
 * Tax comes from each product's taxRate / isTaxInclusive; never trust client totals alone.
 */

export type PricedLine = {
  productId: string;
  quantity: number;
  unitPrice: number;
  taxRate: number; // percent
  isTaxInclusive: boolean;
};

export type CheckoutTotals = {
  subtotal: number; // net of tax (ex-VAT basis for display consistency)
  tax: number;
  shippingFee: number;
  totalAmount: number;
};

const FREE_SHIPPING_THRESHOLD = 100_000;
const DEFAULT_SHIPPING_FEE = 500;

export function computeCheckoutTotals(
  lines: PricedLine[],
  options?: { shippingFee?: number; freeShippingThreshold?: number },
): CheckoutTotals {
  const freeAt = options?.freeShippingThreshold ?? FREE_SHIPPING_THRESHOLD;
  const flatShip = options?.shippingFee ?? DEFAULT_SHIPPING_FEE;

  let net = 0;
  let tax = 0;

  for (const line of lines) {
    const lineGross = line.unitPrice * line.quantity;
    const rate = Math.max(0, line.taxRate || 0);
    if (line.isTaxInclusive && rate > 0) {
      const lineNet = lineGross / (1 + rate / 100);
      net += lineNet;
      tax += lineGross - lineNet;
    } else {
      net += lineGross;
      tax += lineGross * (rate / 100);
    }
  }

  const subtotal = Math.round(net);
  const taxRounded = Math.round(tax);
  const goodsTotal = subtotal + taxRounded;
  const shippingFee = goodsTotal >= freeAt || goodsTotal === 0 ? 0 : flatShip;

  return {
    subtotal,
    tax: taxRounded,
    shippingFee,
    totalAmount: subtotal + taxRounded + shippingFee,
  };
}
