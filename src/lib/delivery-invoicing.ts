/**
 * How a delivered order's money is laid out on its invoice or invoices. Pure, so the invoice, its email, the PDF and what is sent to
 * KRA all read the same figures and cannot disagree.
 *
 * Two ways, chosen by the company:
 *   with_goods  one invoice. Delivery is a line beside the product lines, and the tax is shown for the products, for the delivery,
 *               and in all.
 *   separate    two invoices. The products on one, the delivery service on another, each with its own number, signed on its own.
 *
 * The order keeps `subtotal` (products before tax), `tax` (products and delivery together), `shippingFee` (delivery before tax) and
 * `totalAmount`. The delivery's own tax is kept with its record, so the tax on the products is the order's tax less that.
 */

export const DELIVERY_BILLING_MODES = ['with_goods', 'separate'] as const;
export type DeliveryBillingMode = (typeof DELIVERY_BILLING_MODES)[number];
export const isDeliveryBillingMode = (value: unknown): value is DeliveryBillingMode => typeof value === 'string' && (DELIVERY_BILLING_MODES as readonly string[]).includes(value);

export const DELIVERY_BILLING_WORDS: Record<DeliveryBillingMode, { name: string; means: string }> = {
  with_goods: { name: 'On the same invoice', means: 'Delivery is a line beside the products, in one invoice signed once. The invoice shows the tax on the products, the tax on the delivery and the tax in all.' },
  separate: { name: 'On its own invoice', means: 'The products are invoiced and signed as before, and the delivery service gets a second invoice of its own, with its own number, signed separately.' },
};

const cents = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface OrderMoney {
  /** Products before tax. */
  subtotal: number;
  /** Tax on everything: products and delivery. */
  tax: number;
  /** The charge for delivery before tax. */
  shippingFee: number;
  totalAmount: number;
}

export interface DeliveryMoney {
  net: number;
  tax: number;
  gross: number;
  /** Percent. */
  taxRate: number;
}

export interface TaxRow {
  label: string;
  amount: number;
}

export interface DeliveryLine {
  /** What the document calls it. */
  name: string;
  net: number;
  tax: number;
  gross: number;
  taxRate: number;
}

export interface InvoiceFigures {
  /** Products before tax, plus delivery before tax when it is a line of this invoice. */
  subtotal: number;
  /** Delivery before tax shown in its own "Shipping" row. Only for an order with no delivery record; otherwise delivery is a line. */
  shippingFee: number;
  totalTax: number;
  totalAmount: number;
  /** The tax, in the parts a reader (and KRA) wants: on the products, on the delivery, in all. A single row when there is no delivery tax to separate. */
  taxRows: TaxRow[];
  /** Present when delivery is a line of this invoice. */
  deliveryLine: DeliveryLine | null;
}

export interface InvoicePlan {
  mode: DeliveryBillingMode;
  /** The products' invoice (and, with `with_goods`, the delivery on it). */
  main: InvoiceFigures;
  /** The delivery service's own invoice, for `separate` only. */
  deliveryInvoice: InvoiceFigures | null;
}

const money = (n: number): string => n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rateWords = (r: number): string => (r > 0 ? ` (${String(r)}%)` : '');

/** Lays out the invoice or invoices of an order. `delivery` is null for an order with no delivery charge to bill. */
export function planInvoices(order: OrderMoney, delivery: DeliveryMoney | null, mode: DeliveryBillingMode, deliveryName = 'Delivery'): InvoicePlan {
  if (delivery === null || delivery.gross <= 0) {
    // Nothing to separate: the order's own figures, as they have always been shown.
    return { mode, main: { subtotal: cents(order.subtotal), shippingFee: cents(order.shippingFee), totalTax: cents(order.tax), totalAmount: cents(order.totalAmount), taxRows: [{ label: 'VAT', amount: cents(order.tax) }], deliveryLine: null }, deliveryInvoice: null };
  }
  const line: DeliveryLine = { name: deliveryName, net: cents(delivery.net), tax: cents(delivery.tax), gross: cents(delivery.gross), taxRate: delivery.taxRate };
  const productTax = cents(order.tax - delivery.tax);
  if (mode === 'with_goods') {
    return {
      mode,
      main: {
        subtotal: cents(order.subtotal + line.net),
        shippingFee: 0,
        totalTax: cents(order.tax),
        totalAmount: cents(order.totalAmount),
        taxRows: [
          { label: 'VAT on products', amount: productTax },
          { label: `VAT on delivery${rateWords(line.taxRate)}`, amount: line.tax },
          { label: 'Total VAT', amount: cents(order.tax) },
        ],
        deliveryLine: line,
      },
      deliveryInvoice: null,
    };
  }
  return {
    mode,
    main: { subtotal: cents(order.subtotal), shippingFee: 0, totalTax: productTax, totalAmount: cents(order.subtotal + productTax), taxRows: [{ label: 'VAT', amount: productTax }], deliveryLine: null },
    deliveryInvoice: { subtotal: line.net, shippingFee: 0, totalTax: line.tax, totalAmount: line.gross, taxRows: [{ label: `VAT on delivery${rateWords(line.taxRate)}`, amount: line.tax }], deliveryLine: line },
  };
}

/** A check that what the invoices add up to is what the order says, to the cent. A plan that fails it must not be issued. */
export function planProblem(order: OrderMoney, plan: InvoicePlan): string | null {
  const sum = cents(plan.main.totalAmount + (plan.deliveryInvoice?.totalAmount ?? 0));
  if (Math.abs(sum - cents(order.totalAmount)) < 0.005) return null;
  return `The ${plan.deliveryInvoice === null ? 'invoice' : 'invoices'} (${money(sum)}) ${plan.deliveryInvoice === null ? 'does' : 'do'} not add up to the order (${money(order.totalAmount)}).`;
}
