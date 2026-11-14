import type { StoredPick } from '@/server/domains/pricing/domain/package-shop';
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
    showBillingAddress: true,
    paymentDetails: '',
    termsAndConditions: '',
    sections: [],
    validUntil: new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10),
    customerReference: '',
    neededOn: '',
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
    neededOn: quote.neededOn,
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
        // As it was typed: in the unit it was entered in, at the price per that unit.
        quantity: line.enteredQuantity ?? Number(line.quantity),
        unitPrice: Number(line.enteredUnitPrice ?? line.unitPrice),
        unitId: line.enteredQuantity === null ? null : line.unitId,
        unitCode: line.enteredQuantity === null ? null : line.unitCode,
        // A package is always priced from the package; the choices come back as they were kept.
        priceMode: line.priceTrace?.quotedAsPackage === undefined ? ('kept' as const) : ('catalog' as const),
        discountPercent: Number(line.discountPercent),
        fromTemplate: line.fromTemplate,
        fromSectionTemplate: line.fromSectionTemplate,
        ...(line.priceTrace?.quotedAsPackage === undefined ? {} : { package: { picks: line.priceTrace.quotedAsPackage.picks, summary: line.description, ...(line.priceTrace.quotedAsPackage.note === undefined ? {} : { note: line.priceTrace.quotedAsPackage.note }) }, quantity: Number(line.quantity) }),
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

/** The choices of a package line as the browser sends them: names, a part and a count, bounded. Anything else is dropped. */
function readPackage(raw: unknown): { picks: StoredPick[] } | undefined {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { picks?: unknown }).picks)) return undefined;
  const picks: StoredPick[] = [];
  for (const entry of (raw as { picks: unknown[] }).picks.slice(0, 1000)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const pick = entry as Record<string, unknown>;
    if (typeof pick.slotName === 'string' && pick.slotName.length <= 200 && typeof pick.productId === 'string' && pick.productId.length <= 100 && typeof pick.name === 'string' && pick.name.length <= 200 && typeof pick.count === 'number' && Number.isInteger(pick.count) && pick.count > 0 && pick.count <= 1000) {
      picks.push({ slotName: pick.slotName, productId: pick.productId, name: pick.name, count: pick.count });
    }
  }
  return { picks };
}

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
        (line.unitId !== undefined &&
          line.unitId !== null &&
          (typeof line.unitId !== 'string' || line.unitId.length > 100)) ||
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
        ...(readPackage(line.package) === undefined ? {} : { package: readPackage(line.package) }),
        ...(typeof line.unitPrice === 'number' ? { unitPrice: line.unitPrice } : {}),
        ...(typeof line.sectionId === 'string' ? { sectionId: line.sectionId } : {}),
        ...(typeof line.unitId === 'string' ? { unitId: line.unitId } : {}),
      };
    }),
  };
}
