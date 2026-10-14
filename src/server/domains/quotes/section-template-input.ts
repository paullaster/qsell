/**
 * A section template as it arrives from the browser, checked. Nothing about the browser's copy is
 * trusted: every field's type and size is verified here and the cleaned values are what get saved.
 */
export interface SectionTemplateInput {
  name: string;
  category: string | null;
  description: string | null;
  /** The title, description and print choice of the section a quote gets from this template. */
  sectionTitle: string;
  sectionDescription: string | null;
  showLines: boolean;
  lines: SectionTemplateLineInput[];
}

export interface SectionTemplateLineInput {
  productId: string;
  quantity: number;
  priceMode: 'catalog' | 'fixed';
  /** Set for a fixed price; null when the catalogue price is used. */
  unitPrice: number | null;
  discountPercent: number;
}

export const SECTION_TEMPLATE_LIMITS = {
  name: 120,
  category: 80,
  description: 500,
  title: 120,
  sectionDescription: 500,
  lines: 500,
  quantity: 1_000_000,
  price: 1_000_000_000,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A trimmed string of at most `max` characters; empty is allowed only when not `required`. */
function text(value: unknown, label: string, max: number, required: boolean): string {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label} is required.`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`${label} is not valid.`);
  const clean = value.trim();
  if (required && clean === '') throw new Error(`${label} is required.`);
  if (clean.length > max) throw new Error(`${label} is limited to ${String(max)} characters.`);
  return clean;
}

function optionalText(value: unknown, label: string, max: number): string | null {
  const clean = text(value, label, max, false);
  return clean === '' ? null : clean;
}

function number(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a number from ${String(min)} to ${String(max)}.`);
  }
  return value;
}

export function parseSectionTemplateInput(raw: unknown): SectionTemplateInput {
  if (!isRecord(raw)) throw new Error('Invalid section template.');
  const name = text(raw.name, 'Section template name', SECTION_TEMPLATE_LIMITS.name, true);
  if (raw.showLines !== undefined && typeof raw.showLines !== 'boolean') {
    throw new Error('Keep expanded must be yes or no.');
  }
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) {
    throw new Error('Add at least one product to the section.');
  }
  if (raw.lines.length > SECTION_TEMPLATE_LIMITS.lines) {
    throw new Error(
      `A section template is limited to ${String(SECTION_TEMPLATE_LIMITS.lines)} items.`,
    );
  }
  const lines = (raw.lines as unknown[]).map((entry, index): SectionTemplateLineInput => {
    const where = `Item ${String(index + 1)}`;
    if (!isRecord(entry)) throw new Error(`${where} is not valid.`);
    const productId = text(entry.productId, `${where} product`, 100, true);
    const priceMode = entry.priceMode;
    if (priceMode !== 'catalog' && priceMode !== 'fixed') {
      throw new Error(`${where} needs a price source.`);
    }
    return {
      productId,
      quantity: number(
        entry.quantity,
        `${where} quantity`,
        0.001,
        SECTION_TEMPLATE_LIMITS.quantity,
      ),
      priceMode,
      unitPrice:
        priceMode === 'fixed'
          ? number(entry.unitPrice, `${where} fixed price`, 0, SECTION_TEMPLATE_LIMITS.price)
          : null,
      discountPercent: number(entry.discountPercent, `${where} discount`, 0, 100),
    };
  });
  return {
    name,
    category: optionalText(raw.category, 'Category', SECTION_TEMPLATE_LIMITS.category),
    description: optionalText(raw.description, 'Description', SECTION_TEMPLATE_LIMITS.description),
    // The title defaults to the name, so a template never makes an untitled section.
    sectionTitle:
      optionalText(raw.sectionTitle, 'Section title', SECTION_TEMPLATE_LIMITS.title) ?? name,
    sectionDescription: optionalText(
      raw.sectionDescription,
      'Section description',
      SECTION_TEMPLATE_LIMITS.sectionDescription,
    ),
    showLines: raw.showLines === true,
    lines,
  };
}
