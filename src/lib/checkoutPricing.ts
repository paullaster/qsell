/**
 * Shared storefront + server order pricing.
 * Tax comes from each product's taxRate / isTaxInclusive.
 * Shipping is charged only when a caller passes an explicit fee — there is no built-in rate.
 */

export type PricedLine = {
  productId: string;
  quantity: number;
  unitPrice: number;
  taxRate: number; // percent
  isTaxInclusive: boolean;
};

export type CheckoutTotals = {
  subtotal: number;
  tax: number;
  shippingFee: number;
  totalAmount: number;
};

export function computeCheckoutTotals(
  lines: PricedLine[],
  options?: { shippingFee?: number; freeShippingThreshold?: number },
): CheckoutTotals {
  const flatShip = options?.shippingFee ?? 0;
  const freeAt = options?.freeShippingThreshold;

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
  const shippingFee =
    flatShip <= 0 || goodsTotal === 0 || (freeAt != null && goodsTotal >= freeAt) ? 0 : flatShip;

  return {
    subtotal,
    tax: taxRounded,
    shippingFee,
    totalAmount: subtotal + taxRounded + shippingFee,
  };
}
