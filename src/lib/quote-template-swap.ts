import type { QuoteInput } from '@/server/domains/quotes/service';
import type { SalesQuoteTemplate } from '@/server/domains/quotes/service';

/**
 * Switching the template of a quote that is being edited. Everything here is pure: it works on the
 * form's values and returns new ones, so the switch can be previewed and cancelled before saving.
 *
 * What a quote took from its template is marked `fromTemplate` on its lines and sections. A switch
 * replaces exactly those and the template's header defaults the person has not changed, and it
 * leaves alone the customer, the addresses, the customer reference, the coupons and the validity.
 */
export type SwapTemplate = Pick<
  SalesQuoteTemplate,
  | 'id'
  | 'name'
  | 'currency'
  | 'paymentMethod'
  | 'paymentTerms'
  | 'paymentDetails'
  | 'termsAndConditions'
  | 'showBillingAddress'
  | 'publicNotes'
  | 'internalNotes'
  | 'quoteDiscountPercent'
  | 'shippingFee'
> & {
  sections: Pick<
    SalesQuoteTemplate['sections'][number],
    'id' | 'title' | 'description' | 'showLines'
  >[];
  lines: Pick<
    SalesQuoteTemplate['lines'][number],
    'productId' | 'sectionId' | 'quantity' | 'priceMode' | 'unitPrice' | 'discountPercent'
  >[];
};

type Line = QuoteInput['lines'][number];
type Section = QuoteInput['sections'][number];

/** The template's lines and sections as quote lines and sections, marked as coming from it. */
export function templateContent(
  template: SwapTemplate,
  priceOf: (productId: string) => number | undefined,
  newId: () => string = () => crypto.randomUUID(),
): { sections: Section[]; lines: Line[] } {
  const ids = new Map(template.sections.map((section) => [section.id, newId()]));
  return {
    sections: template.sections.map((section) => ({
      id: ids.get(section.id)!,
      title: section.title,
      description: section.description,
      showLines: section.showLines,
      fromTemplate: true,
    })),
    lines: template.lines.map((line) => ({
      productId: line.productId ?? '',
      sectionId: line.sectionId ? (ids.get(line.sectionId) ?? null) : null,
      quantity: Number(line.quantity),
      unitPrice:
        line.priceMode === 'fixed' ? Number(line.unitPrice ?? 0) : priceOf(line.productId ?? ''),
      priceMode: line.priceMode === 'fixed' ? ('manual' as const) : ('catalog' as const),
      discountPercent: Number(line.discountPercent),
      fromTemplate: true,
    })),
  };
}

/** The header values a template supplies, in the form the quote holds them. */
const headerOf = (t: SwapTemplate) => ({
  currency: t.currency,
  paymentMethod: t.paymentMethod as QuoteInput['paymentMethod'],
  paymentTerms: t.paymentTerms ?? '',
  paymentDetails: t.paymentDetails ?? '',
  termsAndConditions: t.termsAndConditions ?? '',
  showBillingAddress: t.showBillingAddress,
  publicNotes: t.publicNotes ?? '',
  internalNotes: t.internalNotes ?? '',
  discountPercent: Number(t.quoteDiscountPercent),
  shippingFee: Number(t.shippingFee),
});
type Header = ReturnType<typeof headerOf>;

const quoteHeader = (q: QuoteInput): Header => ({
  currency: q.currency,
  paymentMethod: q.paymentMethod,
  paymentTerms: q.paymentTerms ?? '',
  paymentDetails: q.paymentDetails ?? '',
  termsAndConditions: q.termsAndConditions ?? '',
  showBillingAddress: q.showBillingAddress ?? false,
  publicNotes: q.publicNotes ?? '',
  internalNotes: q.internalNotes ?? '',
  discountPercent: q.discountPercent,
  shippingFee: q.shippingFee,
});

const title = (value: string) => value.trim().toLowerCase();

export interface SwapPlan {
  /**
   * `none`: nothing to ask, apply it. `replace`: the quote was built from a template and holds
   * nothing else. `additions`: it also holds things added by hand, so ask whether to keep them.
   * `manual`: it was not built from a template, so the template replaces what it holds.
   */
  kind: 'none' | 'replace' | 'additions' | 'manual';
  /** Items added by hand to a quote built from a template. */
  additions: { lines: Line[]; sections: Section[] };
  /** Items from the old template that were changed since, and are replaced all the same. */
  edited: Line[];
  /** How many of the quote's items and sections the switch replaces. */
  replacedLines: number;
  replacedSections: number;
  /** The form after the switch; `keepAdditions` matters only for `additions`. */
  apply: (keepAdditions: boolean) => QuoteInput;
}

export function planTemplateSwap(
  current: QuoteInput,
  oldTemplate: SwapTemplate | null,
  nextTemplate: SwapTemplate | null,
  priceOf: (productId: string) => number | undefined,
  newId: () => string = () => crypto.randomUUID(),
): SwapPlan {
  const fromTemplate = current.templateId != null;
  const sectionRows = current.sections ?? [];
  const mine = (row: { fromTemplate?: boolean }) => !fromTemplate || row.fromTemplate === true;
  const replacedLines = current.lines.filter(mine);
  const replacedSections = sectionRows.filter(mine);
  const additions = fromTemplate
    ? {
        lines: current.lines.filter((line) => !mine(line)),
        sections: sectionRows.filter((section) => !mine(section)),
      }
    : { lines: [], sections: [] };

  // Lines of the old template that the person has since changed.
  const edited: Line[] = [];
  if (oldTemplate) {
    const sectionTitle = new Map(sectionRows.map((s) => [s.id, title(s.title)]));
    const templateTitle = new Map(oldTemplate.sections.map((s) => [s.id, title(s.title)]));
    const unmatched = [...oldTemplate.lines];
    for (const line of replacedLines) {
      const place = line.sectionId ? sectionTitle.get(line.sectionId) : null;
      const at = unmatched.findIndex(
        (tl) =>
          (tl.productId ?? '') === line.productId &&
          (tl.sectionId ? (templateTitle.get(tl.sectionId) ?? null) : null) === (place ?? null),
      );
      const [tl] = at >= 0 ? unmatched.splice(at, 1) : [];
      if (!tl) continue;
      const priceChanged =
        tl.priceMode === 'fixed' && Number(tl.unitPrice ?? 0) !== (line.unitPrice ?? 0);
      if (
        line.quantity !== Number(tl.quantity) ||
        line.discountPercent !== Number(tl.discountPercent) ||
        priceChanged
      )
        edited.push(line);
    }
  }

  const hasContent = current.lines.length > 0 || sectionRows.length > 0;
  const kind: SwapPlan['kind'] = !fromTemplate
    ? hasContent && nextTemplate
      ? 'manual'
      : 'none'
    : additions.lines.length > 0 || additions.sections.length > 0
      ? 'additions'
      : replacedLines.length > 0 || replacedSections.length > 0
        ? 'replace'
        : 'none';

  const apply = (keepAdditions: boolean): QuoteInput => {
    const next = nextTemplate
      ? templateContent(nextTemplate, priceOf, newId)
      : { sections: [], lines: [] };
    // A manual quote has nothing to keep: the template replaces all of it.
    const keep = fromTemplate && keepAdditions ? additions : { lines: [], sections: [] };
    // Kept items that sat in a section of the old template move to the new template's section of
    // the same name, or become individual items when it has none.
    const newSections = new Map(next.sections.map((s) => [title(s.title), s.id]));
    const oldSectionTitle = new Map(sectionRows.map((s) => [s.id, title(s.title)]));
    const keptIds = new Set(keep.sections.map((s) => s.id));
    const rehome = (sectionId: string | null | undefined) => {
      if (!sectionId || keptIds.has(sectionId)) return sectionId ?? null;
      return newSections.get(oldSectionTitle.get(sectionId) ?? '') ?? null;
    };
    // Header defaults: a template's value replaces the old template's only where it was left alone.
    // A manual quote has no old template to have left alone, so the new template's values replace all.
    const header = nextTemplate ? headerOf(nextTemplate) : null;
    const was = oldTemplate ? headerOf(oldTemplate) : null;
    const now = quoteHeader(current);
    const merged: Partial<Header> = {};
    if (header) {
      for (const key of Object.keys(header) as (keyof Header)[]) {
        if (!fromTemplate || (was && now[key] === was[key])) {
          (merged as Record<string, unknown>)[key] = header[key];
        }
      }
    }
    return {
      ...current,
      ...merged,
      templateId: nextTemplate?.id ?? null,
      sections: [...next.sections, ...keep.sections],
      lines: [
        ...next.lines,
        ...keep.lines.map((line) => ({ ...line, sectionId: rehome(line.sectionId) })),
      ],
    };
  };

  return {
    kind,
    additions,
    edited,
    replacedLines: replacedLines.length,
    replacedSections: replacedSections.length,
    apply,
  };
}
