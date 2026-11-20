/**
 * Where a product or package is offered, by selling document (docs/architecture/selling-documents.md, S-8). Pure.
 * The web shop keeps its own switch (`show on web shop`); this list is for the documents staff take.
 */
export const OFFER_TYPES = ['quote', 'sales_order', 'credit_sale', 'pos_cash_sale', 'sales_invoice'] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

export const OFFER_LABELS: Record<OfferType, string> = {
  quote: 'Sales quotes',
  sales_order: 'Sales orders',
  credit_sale: 'Credit sales',
  pos_cash_sale: 'Cash sales (the counter)',
  sales_invoice: 'Sales invoices',
};

export const isOfferType = (value: unknown): value is OfferType => typeof value === 'string' && (OFFER_TYPES as readonly string[]).includes(value);

/** Where it is offered when nothing was said: everywhere. */
export const OFFERED_EVERYWHERE: readonly OfferType[] = OFFER_TYPES;

/** Whether the product is offered in this kind of document. A product that never had the list (older data, a caller that does not know) is offered everywhere. */
export const isOfferedIn = (offeredIn: readonly string[] | null | undefined, type: OfferType): boolean => offeredIn === null || offeredIn === undefined || offeredIn.includes(type);

/** What the person is told when a product is asked for in a document it is not offered in. */
export const notOfferedRefusal = (productName: string, type: OfferType): string => `${productName} is not offered in ${OFFER_LABELS[type].toLowerCase()}. Change where it is offered on the product.`;

/** Reads what a screen sent for "offered in" (untrusted): only known document types, each once, in their usual order. */
export function readOfferedIn(raw: unknown): { ok: true; value: OfferType[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'Say where this is offered.' };
  const seen = new Set<OfferType>();
  for (const entry of raw) {
    if (!isOfferType(entry)) return { ok: false, error: 'One of the places it is offered is not known.' };
    seen.add(entry);
  }
  return { ok: true, value: OFFER_TYPES.filter((t) => seen.has(t)) };
}

/** The selling document an order of this sales module is, for the check. The web shop has its own switch and is not checked here. */
export function offerTypeOfModule(salesModule: string | undefined, onAccount: boolean): OfferType | null {
  if (onAccount || salesModule === 'credit_sale') return 'credit_sale';
  if (salesModule === 'sales_order' || salesModule === 'sales_invoice' || salesModule === 'pos_cash_sale') return salesModule;
  return null;
}
