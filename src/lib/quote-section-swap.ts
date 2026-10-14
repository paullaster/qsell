import type { QuoteInput } from '@/server/domains/quotes/service';
import type { SectionTemplate } from '@/server/domains/quotes/section-template-service';
import type { SwapPlan } from './quote-template-swap';

/**
 * Section templates on a quote: adding a section from one, and switching the template of a section
 * that is already on the quote. Pure, like the quote-level switch in `quote-template-swap`: it
 * works on the form's values so the change can be previewed and cancelled before saving.
 *
 * A section made from a template is marked with it (`sectionTemplateId`), and so are the items it
 * brought (`fromSectionTemplate`). Switching replaces exactly those, and the section's title,
 * description and print choice where they were left as the old template had them. Items added by
 * hand inside the section are the person's to keep or remove. A section made from a section
 * template is not part of the quote's own template, so a quote-level switch treats it as an
 * addition.
 */
export type SectionSwapTemplate = Pick<
  SectionTemplate,
  'id' | 'name' | 'sectionTitle' | 'sectionDescription' | 'showLines'
> & {
  lines: Pick<
    SectionTemplate['lines'][number],
    'productId' | 'quantity' | 'priceMode' | 'unitPrice' | 'discountPercent'
  >[];
};

type Line = QuoteInput['lines'][number];
type Section = QuoteInput['sections'][number];

/** The template's section and items, as a quote section and quote lines. */
export function sectionTemplateContent(
  template: SectionSwapTemplate,
  sectionId: string,
  priceOf: (productId: string) => number | undefined,
): { section: Section; lines: Line[] } {
  return {
    section: {
      id: sectionId,
      title: template.sectionTitle,
      description: template.sectionDescription,
      showLines: template.showLines,
      fromTemplate: false,
      sectionTemplateId: template.id,
    },
    lines: template.lines.map((line) => ({
      productId: line.productId ?? '',
      sectionId,
      quantity: Number(line.quantity),
      unitPrice:
        line.priceMode === 'fixed' ? Number(line.unitPrice ?? 0) : priceOf(line.productId ?? ''),
      priceMode: line.priceMode === 'fixed' ? ('manual' as const) : ('catalog' as const),
      discountPercent: Number(line.discountPercent),
      fromTemplate: false,
      fromSectionTemplate: true,
    })),
  };
}

/** The form with a new section made from the template added after the others. */
export function addSectionFromTemplate(
  current: QuoteInput,
  template: SectionSwapTemplate,
  priceOf: (productId: string) => number | undefined,
  newId: () => string = () => crypto.randomUUID(),
): QuoteInput {
  const { section, lines } = sectionTemplateContent(template, newId(), priceOf);
  return {
    ...current,
    sections: [...(current.sections ?? []), section],
    lines: [...current.lines, ...lines],
  };
}

export function planSectionSwap(
  current: QuoteInput,
  sectionId: string,
  oldTemplate: SectionSwapTemplate | null,
  nextTemplate: SectionSwapTemplate | null,
  priceOf: (productId: string) => number | undefined,
): SwapPlan {
  const section = (current.sections ?? []).find((row) => row.id === sectionId);
  const inSection = current.lines.filter((line) => line.sectionId === sectionId);
  const fromTemplate = section?.sectionTemplateId != null;
  const mine = (line: Line) => !fromTemplate || line.fromSectionTemplate === true;
  const replaced = inSection.filter(mine);
  const additions = fromTemplate ? inSection.filter((line) => !mine(line)) : [];

  // Items of the old template that the person has since changed.
  const edited: Line[] = [];
  if (oldTemplate) {
    const unmatched = [...oldTemplate.lines];
    for (const line of replaced) {
      const at = unmatched.findIndex((tl) => (tl.productId ?? '') === line.productId);
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

  const kind: SwapPlan['kind'] = !fromTemplate
    ? replaced.length > 0 && nextTemplate
      ? 'manual'
      : 'none'
    : additions.length > 0
      ? 'additions'
      : replaced.length > 0
        ? 'replace'
        : 'none';

  const apply = (keepAdditions: boolean): QuoteInput => {
    if (!section) return current;
    const next = nextTemplate ? sectionTemplateContent(nextTemplate, sectionId, priceOf) : null;
    // Title, description and print choice follow the new template where they were not edited; a
    // section made by hand has none to compare with, so the template's replace them.
    const take = <K extends 'title' | 'description' | 'showLines'>(
      key: K,
      was: Section[K] | undefined,
    ): Section[K] | undefined => {
      if (!next) return section[key];
      const untouched = !fromTemplate || (section[key] ?? '') === (was ?? '');
      return untouched ? next.section[key] : section[key];
    };
    const sectionWas = oldTemplate && {
      title: oldTemplate.sectionTitle,
      description: oldTemplate.sectionDescription ?? '',
      showLines: oldTemplate.showLines,
    };
    const merged: Section = {
      ...section,
      title: take('title', sectionWas?.title) ?? section.title,
      description: take('description', sectionWas?.description),
      showLines: take('showLines', sectionWas?.showLines),
      sectionTemplateId: nextTemplate?.id ?? null,
      // Made from a section template, the section is no longer part of the quote's own template.
      fromTemplate: next ? false : section.fromTemplate,
    };
    const kept = fromTemplate && keepAdditions ? additions : [];
    return {
      ...current,
      sections: (current.sections ?? []).map((row) => (row.id === sectionId ? merged : row)),
      lines: [
        ...current.lines.filter((line) => line.sectionId !== sectionId),
        ...(next?.lines ?? []),
        ...kept,
      ],
    };
  };

  return {
    kind,
    additions: { lines: additions, sections: [] },
    edited,
    replacedLines: replaced.length,
    replacedSections: 0,
    apply,
  };
}
