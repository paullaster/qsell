/** What a person sees for an invoice in a list or on a document: the number the customer was given, the order behind it, and what was sold. */

export interface InvoiceLineView {
  id: string;
  name: string;
  sku: string;
  quantity: string;
  unit: string | null;
  unitPrice: string;
  total: string;
  gift: boolean;
  savedAmount?: string | null;
  discountLabel?: string | null;
}

export interface InvoiceReferenceView {
  /** The ledger's own number for the entry (for a sale it is the order number). */
  documentNo: string;
  /** The tax invoice number issued for the order, when one has been issued. */
  invoiceNo: string | null;
  orderNumber: string | null;
  /** The order's own id, for a link to it. */
  orderId?: string | null;
  lines: InvoiceLineView[];
}

/**
 * The words that name an invoice. A sale's ledger entry carries the order number, so it must never be presented as the invoice number:
 * the invoice number is shown when one was issued, and the order is named as an order otherwise.
 */
export function invoiceTitle(
  ref: Pick<InvoiceReferenceView, 'documentNo' | 'invoiceNo' | 'orderNumber'>,
): { title: string; order: string | null } {
  const hasInvoice = ref.invoiceNo !== null && ref.invoiceNo !== '';
  if (hasInvoice)
    return {
      title: `Invoice ${ref.invoiceNo ?? ''}`,
      order: ref.orderNumber !== null && ref.orderNumber !== '' ? `Order ${ref.orderNumber}` : null,
    };
  if (ref.orderNumber !== null && ref.orderNumber !== '')
    return { title: `Order ${ref.orderNumber}`, order: null };
  return { title: ref.documentNo, order: null };
}

/** One line in words: "2 × Blue shirt (SKU1)". Quantities keep the unit they were sold in. */
export function lineText(line: InvoiceLineView): string {
  const qty =
    line.unit !== null && line.unit !== '' ? `${line.quantity} ${line.unit}` : line.quantity;
  const free = line.gift ? ' (free gift)' : '';
  return `${qty} × ${line.name}${free}`;
}

/** The lines to print, capped so one invoice cannot swamp a receipt; says how many were left out. */
export function printableLines(
  lines: readonly InvoiceLineView[],
  max = 12,
): { shown: InvoiceLineView[]; more: number } {
  return { shown: lines.slice(0, max), more: Math.max(lines.length - max, 0) };
}

export function invoiceLineDiscount(
  trace:
    | {
        discounts?: {
          lineTotalBefore: number;
          applied: { name: string; code: string; couponCode?: string }[];
        } | null;
      }
    | null
    | undefined,
  total: string,
): { savedAmount: string | null; discountLabel: string | null } {
  const discounts = trace?.discounts;
  if (discounts === undefined || discounts === null)
    return { savedAmount: null, discountLabel: null };
  const savedCents = Math.max(0, Math.round((discounts.lineTotalBefore - Number(total)) * 100));
  const discountLabel = discounts.applied
    .map((rule) => {
      const name = rule.name.trim() === '' ? rule.code : rule.name;
      return rule.couponCode !== undefined && rule.couponCode !== ''
        ? `${name} (coupon ${rule.couponCode})`
        : name;
    })
    .filter((label) => label !== '')
    .join('; ');
  return {
    savedAmount: savedCents === 0 ? null : (savedCents / 100).toFixed(2),
    discountLabel: discountLabel === '' ? null : discountLabel,
  };
}
