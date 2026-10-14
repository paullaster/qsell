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
    sections: [...current.sections, section],
    lines: [...current.lines, ...lines],
  };
}

/** Items of the old template that the person has since changed, matched by product. */
function changedSince(oldTemplate: SectionSwapTemplate, replaced: Line[]): Line[] {
  const unmatched = [...oldTemplate.lines];
  const edited: Line[] = [];
  for (const line of replaced) {
    const at = unmatched.findIndex((tl) => (tl.productId ?? '') === line.productId);
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
  hasReplaced: boolean;
  toTemplate: boolean;
  hasAdditions: boolean;
}): SwapPlan['kind'] {
  if (!facts.fromTemplate) return facts.hasReplaced && facts.toTemplate ? 'manual' : 'none';
  if (facts.hasAdditions) return 'additions';
  return facts.hasReplaced ? 'replace' : 'none';
}

type Header = Pick<Section, 'title' | 'description' | 'showLines'>;

/**
 * Title, description and print choice after a switch: the new template's where the person left
 * them as the old template had them. A section made by hand has no old template to compare with,
 * so the new template's replace them. Removing the template leaves them alone.
 */
function mergedHeader(
  section: Section,
  fromTemplate: boolean,
  oldTemplate: SectionSwapTemplate | null,
  next: Header | null,
): Header {
  if (next === null) {
    return {
      title: section.title,
      description: section.description,
      showLines: section.showLines,
    };
  }
  const was =
    oldTemplate === null
      ? null
      : {
          title: oldTemplate.sectionTitle,
          description: oldTemplate.sectionDescription ?? '',
          showLines: oldTemplate.showLines,
        };
  const untouched = (now: unknown, before: unknown): boolean =>
    !fromTemplate || (was !== null && (now ?? '') === (before ?? ''));
  return {
    title: untouched(section.title, was?.title) ? next.title : section.title,
    description: untouched(section.description, was?.description)
      ? next.description
      : section.description,
    showLines: untouched(section.showLines, was?.showLines) ? next.showLines : section.showLines,
  };
}

export function planSectionSwap(
  current: QuoteInput,
  sectionId: string,
  oldTemplate: SectionSwapTemplate | null,
  nextTemplate: SectionSwapTemplate | null,
  priceOf: (productId: string) => number | undefined,
): SwapPlan {
  const section = current.sections.find((row) => row.id === sectionId);
  const inSection = current.lines.filter((line) => line.sectionId === sectionId);
  const fromTemplate =
    section?.sectionTemplateId !== undefined && section.sectionTemplateId !== null;
  const mine = (line: Line) => !fromTemplate || line.fromSectionTemplate === true;
  const replaced = inSection.filter(mine);
  const additions = fromTemplate ? inSection.filter((line) => !mine(line)) : [];
  const edited = oldTemplate === null ? [] : changedSince(oldTemplate, replaced);
  const kind = kindOf({
    fromTemplate,
    hasReplaced: replaced.length > 0,
    toTemplate: nextTemplate !== null,
    hasAdditions: additions.length > 0,
  });

  const apply = (keepAdditions: boolean): QuoteInput => {
    if (section === undefined) return current;
    const next =
      nextTemplate === null ? null : sectionTemplateContent(nextTemplate, sectionId, priceOf);
    const merged: Section = {
      ...section,
      ...mergedHeader(section, fromTemplate, oldTemplate, next === null ? null : next.section),
      sectionTemplateId: nextTemplate === null ? null : nextTemplate.id,
      // Made from a section template, the section is no longer part of the quote's own template.
      fromTemplate: next === null ? section.fromTemplate : false,
    };
    const kept = fromTemplate && keepAdditions ? additions : [];
    return {
      ...current,
      sections: current.sections.map((row) => (row.id === sectionId ? merged : row)),
      lines: [
        ...current.lines.filter((line) => line.sectionId !== sectionId),
        ...(next === null ? [] : next.lines),
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
