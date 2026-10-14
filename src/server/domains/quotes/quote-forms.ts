import type { QuoteInput, SalesQuote } from './service';
import type { TotalsLine } from './totals';

/** The form for a quote that has nothing in it yet. */
export function blankQuoteForm(now: Date): QuoteInput {
  return {
    customerName: '',
    customerEmail: '',
    customerPhone: '',
    billingAddress: {},
    deliveryAddress: {},
    currency: 'KES',
    paymentMethod: 'mpesa_daraja',
    paymentTerms: '',
    templateId: null,
    showBillingAddress: false,
    paymentDetails: '',
    termsAndConditions: '',
    sections: [],
    validUntil: new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10),
    customerReference: '',
    publicNotes: '',
    internalNotes: '',
    discountPercent: 0,
    shippingFee: 0,
    couponCodes: [],
    lines: [],
  };
}

/**
 * The form for editing a saved quote. Sections get new ids (the editor works on its own copy), the
 * price already agreed is kept as it is until someone asks to reprice, and free gifts are left out
 * because they are worked out again on every save.
 */
export function quoteFormOf(quote: SalesQuote, newId: () => string): QuoteInput {
  const sectionIds = new Map(quote.sections.map((section) => [section.id, newId()]));
  return {
    customerId: quote.customerId,
    customerName: quote.customerName,
    customerEmail: quote.customerEmail,
    customerPhone: quote.customerPhone,
    billingAddress: quote.billingAddress,
    deliveryAddress: quote.deliveryAddress,
    currency: quote.currency,
    paymentMethod: quote.paymentMethod as QuoteInput['paymentMethod'],
    paymentTerms: quote.paymentTerms,
    templateId: quote.templateId,
    templateName: quote.templateName,
    showBillingAddress: quote.showBillingAddress,
    paymentDetails: quote.paymentDetails,
    termsAndConditions: quote.termsAndConditions,
    sections: quote.sections.map((section) => ({
      id: sectionIds.get(section.id) ?? section.id,
      title: section.title,
      description: section.description,
      showLines: section.showLines,
      fromTemplate: section.fromTemplate,
      sectionTemplateId: section.sectionTemplateId,
      sectionTemplateName: section.sectionTemplateName,
    })),
    validUntil: quote.validUntil === null ? null : quote.validUntil.toISOString().slice(0, 10),
    customerReference: quote.customerReference,
    publicNotes: quote.publicNotes,
    internalNotes: quote.internalNotes,
    discountPercent: Number(quote.quoteDiscountPercent),
    shippingFee: Number(quote.shippingFee),
    couponCodes: quote.couponCodes,
    lines: quote.lines
      .filter((line) => !line.isGift)
      .map((line) => ({
        productId: line.productId ?? '',
        sectionId: line.sectionId === null ? null : (sectionIds.get(line.sectionId) ?? null),
        quantity: Number(line.quantity),
        unitPrice: Number(line.unitPrice),
        priceMode: 'kept' as const,
        discountPercent: Number(line.discountPercent),
        fromTemplate: line.fromTemplate,
        fromSectionTemplate: line.fromSectionTemplate,
      })),
  };
}

export const TOTALS_MAX_LINES = 5000;

export interface TotalsRequest {
  lines: TotalsLine[];
  discountPercent: number;
  shippingFee: number;
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Checks what the browser sends to have a quote's totals worked out. */
export function parseTotalsRequest(raw: unknown): TotalsRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Invalid quote.');
  }
  const { lines, discountPercent, shippingFee } = raw as Record<string, unknown>;
  if (!Array.isArray(lines) || lines.length > TOTALS_MAX_LINES) {
    throw new Error('Invalid quote items.');
  }
  if (!finite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw new Error('The quote discount must be between 0 and 100.');
  }
  if (!finite(shippingFee) || shippingFee < 0 || shippingFee > 1_000_000_000) {
    throw new Error('Shipping must be zero or a positive amount.');
  }
  return {
    discountPercent,
    shippingFee,
    lines: (lines as unknown[]).map((entry): TotalsLine => {
      if (typeof entry !== 'object' || entry === null) throw new Error('Invalid quote items.');
      const line = entry as Record<string, unknown>;
      if (
        typeof line.productId !== 'string' ||
        line.productId.length > 100 ||
        !finite(line.quantity) ||
        line.quantity < 0 ||
        line.quantity > 1_000_000 ||
        !finite(line.discountPercent) ||
        line.discountPercent < 0 ||
        line.discountPercent > 100 ||
        (line.sectionId !== undefined &&
          line.sectionId !== null &&
          (typeof line.sectionId !== 'string' || line.sectionId.length > 100)) ||
        (line.unitPrice !== undefined &&
          line.unitPrice !== null &&
          (!finite(line.unitPrice) || line.unitPrice < 0 || line.unitPrice > 1_000_000_000))
      ) {
        throw new Error('Invalid quote items.');
      }
      return {
        productId: line.productId,
        quantity: line.quantity,
        discountPercent: line.discountPercent,
        ...(typeof line.unitPrice === 'number' ? { unitPrice: line.unitPrice } : {}),
        ...(typeof line.sectionId === 'string' ? { sectionId: line.sectionId } : {}),
      };
    }),
  };
}
