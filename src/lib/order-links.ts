/** Addresses that open one order, or the invoice of one order. An order opens over the screen the person is on (and closing it returns there); a pasted address opens it as a page. */

const ORDER_ID = /^[\w-]{1,100}$/;

/** The order as its own address: over the current screen when reached from a link inside the admin, a page when typed or reloaded. */
export const orderHref = (orderId: string): string => `/admin/orders/view/${encodeURIComponent(orderId)}`;

/** The invoice of that order, opened over the order. */
export const invoiceHref = (orderId: string): string => `${orderHref(orderId)}?invoice=1`;

export interface OrderTarget {
  /** The order the address names, when it is shaped like an order id. */
  orderId: string | null;
  /** The invoice preview was asked for too. */
  invoice: boolean;
}

/** What an address asked to open (the order id is read from the address or the older `?order=` form). An id that is not shaped like one is ignored, never looked up. */
export function parseOrderTarget(params: { order?: string | string[]; invoice?: string | string[] }): OrderTarget {
  const order = typeof params.order === 'string' && ORDER_ID.test(params.order) ? params.order : null;
  return { orderId: order, invoice: order !== null && params.invoice === '1' };
}

export type OrderChannel = 'ecommerce' | 'sales_order' | 'credit_sale' | 'pos_cash_sale' | 'sales_invoice';

const CHANNELS: Record<OrderChannel, { kind: string; homeHref: string; homeName: string }> = {
  ecommerce: { kind: 'Web shop order', homeHref: '/admin/orders', homeName: 'Web Shop Orders' },
  sales_order: { kind: 'Sales order', homeHref: '/admin/sales-orders', homeName: 'Sales Orders' },
  credit_sale: { kind: 'Credit sale', homeHref: '/admin/credit-sales', homeName: 'Credit Sales' },
  pos_cash_sale: { kind: 'Cash sale', homeHref: '/admin/cash-sales', homeName: 'Cash Sales' },
  sales_invoice: { kind: 'Sales invoice', homeHref: '/admin/sales-invoices', homeName: 'Sales Invoices' },
};

/** What kind of order it is, and the screen it belongs to (where "back" goes when the order was opened by address). An order made before channels were recorded is a web shop order. */
export function orderChannel(salesModule: string | null | undefined): { kind: string; homeHref: string; homeName: string } {
  const known = (Object.keys(CHANNELS) as OrderChannel[]).find((key) => key === salesModule);
  return CHANNELS[known ?? 'ecommerce'];
}
