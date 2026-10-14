import type { QuoteInput, SalesQuoteTemplate } from '@/server/domains/quotes/service';

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
  newId: () => string,
): { sections: Section[]; lines: Line[] } {
  const sections = template.sections.map((section) => ({
    templateSectionId: section.id,
    section: {
      id: newId(),
      title: section.title,
      description: section.description,
      showLines: section.showLines,
      fromTemplate: true,
    },
  }));
  const ids = new Map(sections.map((row) => [row.templateSectionId, row.section.id]));
  return {
    sections: sections.map((row) => row.section),
    lines: template.lines.map((line) => ({
      productId: line.productId ?? '',
      sectionId: line.sectionId === null ? null : (ids.get(line.sectionId) ?? null),
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

/** Which of the quote's template items were changed since, matched by product and section name. */
function changedSince(
  oldTemplate: SwapTemplate,
  sectionRows: Section[],
  replacedLines: Line[],
): Line[] {
  const sectionTitle = new Map(sectionRows.map((row) => [row.id, title(row.title)]));
  const templateTitle = new Map(oldTemplate.sections.map((row) => [row.id, title(row.title)]));
  const unmatched = [...oldTemplate.lines];
  const edited: Line[] = [];
  for (const line of replacedLines) {
    const place =
      line.sectionId === undefined || line.sectionId === null
        ? null
        : (sectionTitle.get(line.sectionId) ?? null);
    const at = unmatched.findIndex(
      (tl) =>
        (tl.productId ?? '') === line.productId &&
        (tl.sectionId === null ? null : (templateTitle.get(tl.sectionId) ?? null)) === place,
    );
    if (at < 0) continue;
    const [tl] = unmatched.splice(at, 1);
    const priceChanged =
      tl.priceMode === 'fixed' && Number(tl.unitPrice ?? 0) !== (line.unitPrice ?? 0);
    if (
      line.quantity !== Number(tl.quantity) ||
      line.discountPercent !== Number(tl.discountPercent) ||
      priceChanged
    ) {
      edited.push(line);
    }
  }
  return edited;
}

/** What a switch asks about (see `SwapPlan.kind`). */
function kindOf(facts: {
  fromTemplate: boolean;
  hasContent: boolean;
  toTemplate: boolean;
  hasAdditions: boolean;
  hasReplaced: boolean;
}): SwapPlan['kind'] {
  if (!facts.fromTemplate) return facts.hasContent && facts.toTemplate ? 'manual' : 'none';
  if (facts.hasAdditions) return 'additions';
  return facts.hasReplaced ? 'replace' : 'none';
}

/**
 * Header defaults after a switch: the new template's value replaces the old template's only where
 * the person left it alone. A quote with no template has none to have left alone, so the new
 * template's values replace all.
 */
function mergedHeader(
  current: QuoteInput,
  oldTemplate: SwapTemplate | null,
  nextTemplate: SwapTemplate,
): Partial<Header> {
  const header = headerOf(nextTemplate);
  const was = oldTemplate === null ? null : headerOf(oldTemplate);
  const now = quoteHeader(current);
  const fromTemplate = current.templateId !== undefined && current.templateId !== null;
  const merged: Partial<Header> = {};
  for (const key of Object.keys(header) as (keyof Header)[]) {
    if (!fromTemplate || (was !== null && now[key] === was[key])) {
      Object.assign(merged, { [key]: header[key] });
    }
  }
  return merged;
}

export function planTemplateSwap(
  current: QuoteInput,
  oldTemplate: SwapTemplate | null,
  nextTemplate: SwapTemplate | null,
  priceOf: (productId: string) => number | undefined,
  newId: () => string,
): SwapPlan {
  const fromTemplate = current.templateId !== undefined && current.templateId !== null;
  const sectionRows = current.sections;
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
  const edited = oldTemplate === null ? [] : changedSince(oldTemplate, sectionRows, replacedLines);

  const hasContent = current.lines.length > 0 || sectionRows.length > 0;
  const kind = kindOf({
    fromTemplate,
    hasContent,
    toTemplate: nextTemplate !== null,
    hasAdditions: additions.lines.length > 0 || additions.sections.length > 0,
    hasReplaced: replacedLines.length > 0 || replacedSections.length > 0,
  });

  const apply = (keepAdditions: boolean): QuoteInput => {
    const next =
      nextTemplate === null
        ? { sections: [], lines: [] }
        : templateContent(nextTemplate, priceOf, newId);
    // A manual quote has nothing to keep: the template replaces all of it.
    const keep = fromTemplate && keepAdditions ? additions : { lines: [], sections: [] };
    // Kept items that sat in a section of the old template move to the new template's section of
    // the same name, or become individual items when it has none.
    const newSections = new Map(next.sections.map((s) => [title(s.title), s.id]));
    const oldSectionTitle = new Map(sectionRows.map((s) => [s.id, title(s.title)]));
    const keptIds = new Set(keep.sections.map((s) => s.id));
    const rehome = (sectionId: string | null | undefined): string | null => {
      if (sectionId === undefined || sectionId === null || sectionId === '') return null;
      if (keptIds.has(sectionId)) return sectionId;
      return newSections.get(oldSectionTitle.get(sectionId) ?? '') ?? null;
    };
    // Header defaults: a template's value replaces the old template's only where it was left alone.
    // A manual quote has no old template to have left alone, so the new template's values replace all.
    const merged = nextTemplate === null ? {} : mergedHeader(current, oldTemplate, nextTemplate);
    return {
      ...current,
      ...merged,
      templateId: nextTemplate === null ? null : nextTemplate.id,
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
