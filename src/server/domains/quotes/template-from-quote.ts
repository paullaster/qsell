import { randomUUID } from 'node:crypto';
import type { PaymentProvider } from '@/types/index';
import type { QuoteTemplateInput } from './service';

/** What of a saved quote a template is made from. */
export interface QuoteForTemplate {
  quoteNumber: string;
  customerId: string | null;
  customerName: string;
  currency: string;
  paymentMethod: string;
  paymentTerms: string | null;
  paymentDetails: string | null;
  termsAndConditions: string | null;
  showBillingAddress: boolean;
  validUntil: Date | null;
  createdAt: Date;
  quoteDiscountPercent: string | number;
  shippingFee: string | number;
  publicNotes: string | null;
  internalNotes: string | null;
  billingAddress: Record<string, string>;
  deliveryAddress: Record<string, string>;
  sections: Array<{ id: string; title: string; description: string | null; showLines: boolean }>;
  lines: Array<{
    sectionId: string | null;
    productId: string | null;
    description: string;
    quantity: string | number;
    unitPrice: string | number;
    discountPercent: string | number;
    isGift: boolean;
    /** The pricing explanation: its source is 'none' (or it is absent) when someone typed the price. */
    priceTrace: unknown;
  }>;
}

export interface TemplateDraft {
  input: QuoteTemplateInput;
  /** Items left out, and why, so the person is told rather than left to wonder. */
  skipped: Array<{ name: string; reason: string }>;
  /** Free gifts the quote had: they are worked out again for each new quote, so not copied. */
  gifts: number;
  quoteNumber: string;
}

const DAY = 86_400_000;

/**
 * The template a quote would make, ready to review in the template editor. Every part of the
 * quote is kept (its arrangement, sections and whether they print expanded, quantities, terms and
 * notes) except what only belongs to that one sale:
 *  - lines priced by the price lists stay catalog-priced, so the template follows today's prices;
 *    lines with a typed price keep that price as a fixed one;
 *  - the customer, and so the addresses, are left out unless asked for;
 *  - free gifts are not copied, and items that can no longer be sold are left out and reported.
 */
export function templateDraftFromQuote(
  quote: QuoteForTemplate,
  opts: {
    keepCustomer?: boolean;
    /** Lower-cased names already used by templates, so the suggestion is free. */
    takenNames?: Set<string>;
    /** Whether a product can still be sold. Defaults to yes. */
    canSell?: (productId: string) => boolean;
    newId?: () => string;
  } = {},
): TemplateDraft {
  const newId = opts.newId ?? randomUUID;
  const keep = opts.keepCustomer === true;
  const taken = opts.takenNames ?? new Set<string>();
  const sectionIds = new Map(quote.sections.map((s) => [s.id, newId()]));

  let name = `${quote.quoteNumber} template`;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1)
    name = `${quote.quoteNumber} template (${n})`;

  const skipped: TemplateDraft['skipped'] = [];
  let gifts = 0;
  const lines: QuoteTemplateInput['lines'] = [];
  for (const line of quote.lines) {
    if (line.isGift) {
      gifts += 1;
      continue;
    }
    if (!line.productId) {
      skipped.push({ name: line.description, reason: 'The product no longer exists.' });
      continue;
    }
    if (opts.canSell && !opts.canSell(line.productId)) {
      skipped.push({ name: line.description, reason: 'The product can no longer be sold.' });
      continue;
    }
    // A price taken from the price lists or the standard price has a source; a typed one says 'none'.
    const source = (line.priceTrace as { source?: string } | null)?.source;
    const catalog = source != null && source !== 'none';
    lines.push({
      sectionId: line.sectionId ? (sectionIds.get(line.sectionId) ?? null) : null,
      productId: line.productId,
      quantity: Number(line.quantity),
      priceMode: catalog ? 'catalog' : 'fixed',
      unitPrice: catalog ? null : Number(line.unitPrice),
      discountPercent: Number(line.discountPercent),
    });
  }

  const days = quote.validUntil
    ? Math.floor((quote.validUntil.getTime() - quote.createdAt.getTime()) / DAY)
    : 30;
  const hasAddress = (a: Record<string, string>) =>
    Object.values(a).some((v) => v.trim().length > 0);

  return {
    quoteNumber: quote.quoteNumber,
    gifts,
    skipped,
    input: {
      name,
      category: null,
      description: `Made from quote ${quote.quoteNumber}${keep ? ` for ${quote.customerName}` : ''}.`,
      customerId: keep ? quote.customerId : null,
      currency: quote.currency,
      paymentMethod: quote.paymentMethod as PaymentProvider,
      paymentTerms: quote.paymentTerms,
      paymentDetails: quote.paymentDetails,
      termsAndConditions: quote.termsAndConditions,
      showBillingAddress: keep && quote.showBillingAddress && hasAddress(quote.billingAddress),
      validityDays: Math.min(3650, Math.max(1, days)),
      quoteDiscountPercent: Number(quote.quoteDiscountPercent),
      shippingFee: Number(quote.shippingFee),
      billingAddress: keep ? quote.billingAddress : {},
      deliveryAddress: keep ? quote.deliveryAddress : {},
      publicNotes: quote.publicNotes,
      internalNotes: quote.internalNotes,
      tags: [],
      isDefault: false,
      sections: quote.sections.map((s) => ({
        id: sectionIds.get(s.id)!,
        title: s.title,
        description: s.description,
        showLines: s.showLines,
      })),
      lines,
    },
  };
}
