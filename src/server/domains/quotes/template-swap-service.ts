import { getContainer } from '@/server/di/container';
import { CatalogService } from '@/server/domains/catalog/service';
import { planSectionSwap, addSectionFromTemplate } from '@/lib/quote-section-swap';
import { planTemplateSwap, templateContent, type SwapPlan } from '@/lib/quote-template-swap';
import { SalesQuoteService, type QuoteInput } from './service';
import { SectionTemplateService } from './section-template-service';

/**
 * Switching templates on a quote, decided here on the server. The browser sends the form as it
 * stands and the template it chose; it gets back what the dialog needs to ask (what would be
 * replaced, what was added by hand) and the form both ways, with the additions kept and with them
 * removed. The browser holds no template data and makes no decision.
 */
export interface SwapSummary {
  kind: SwapPlan['kind'];
  replacedLines: number;
  replacedSections: number;
  /** Things added by hand that a switch would ask about. */
  additions: {
    items: { key: string; name: string }[];
    sections: { key: string; title: string; items: number }[];
  };
  /** Template items that were changed since, and are replaced all the same. */
  edited: { key: string; name: string }[];
  /** The form after the switch, keeping the additions. */
  keep: QuoteInput;
  /** The form after the switch, without the additions. */
  drop: QuoteInput;
  /** The template switched to, if any. */
  toName: string | null;
  /** The template switched from, if any. */
  fromName: string | null;
}

const MAX_LINES = 5000;
const MAX_SECTIONS = 500;

/** The form comes from the browser: check it is shaped like one before working on it. */
export function assertQuoteFormShape(input: unknown): asserts input is QuoteInput {
  if (typeof input !== 'object' || input === null) throw new Error('Invalid quote.');
  const { lines, sections } = input as { lines?: unknown; sections?: unknown };
  if (!Array.isArray(lines) || lines.length > MAX_LINES) throw new Error('Invalid quote items.');
  if (sections !== undefined && (!Array.isArray(sections) || sections.length > MAX_SECTIONS)) {
    throw new Error('Invalid quote sections.');
  }
  for (const entry of lines as unknown[]) {
    if (typeof entry !== 'object' || entry === null) throw new Error('Invalid quote items.');
    const line = entry as Record<string, unknown>;
    if (
      typeof line.productId !== 'string' ||
      typeof line.quantity !== 'number' ||
      !Number.isFinite(line.quantity) ||
      typeof line.discountPercent !== 'number'
    )
      throw new Error('Invalid quote items.');
  }
  for (const entry of (sections ?? []) as unknown[]) {
    if (typeof entry !== 'object' || entry === null) throw new Error('Invalid quote sections.');
    const section = entry as Record<string, unknown>;
    if (typeof section.id !== 'string' || typeof section.title !== 'string')
      throw new Error('Invalid quote sections.');
  }
}

type RawForm = Omit<QuoteInput, 'sections'> & { sections?: QuoteInput['sections'] };

/** The form from the browser, checked, with `sections` always present. */
export function parseQuoteForm(raw: unknown): QuoteInput {
  assertQuoteFormShape(raw);
  const { sections } = raw as RawForm;
  return { ...raw, sections: sections ?? [] };
}

/** True when an address has a street, the sign it was filled in. */
const hasStreet = (address: Record<string, string>): boolean =>
  typeof address.street === 'string' && address.street !== '';

export class TemplateSwapService {
  private readonly quotes = new SalesQuoteService();
  private readonly sectionTemplates = new SectionTemplateService();

  /** The template's own address when it has one, otherwise the customer's. */
  private addressOf(
    own: Record<string, string>,
    customers: Record<string, string>,
  ): Record<string, string> {
    return hasStreet(own) ? own : customers;
  }

  private async priceLookup(productIds: string[]) {
    const products = await CatalogService.getProductsByIds([...new Set(productIds)]);
    const byId = new Map(products.map((product) => [product.id, product]));
    return {
      priceOf: (id: string) => byId.get(id)?.price,
      nameOf: (id: string) => byId.get(id)?.name ?? 'Unknown item',
      byId,
    };
  }

  /** A template the form may use: it exists for this company, and is active unless already in use. */
  private async quoteTemplate(id: string, current: string | null | undefined) {
    const template = await this.quotes.getTemplate(id);
    if (!template) throw new Error('The selected quote template is no longer available.');
    if (template.status === 'archived' && current !== template.id) {
      throw new Error('Archived templates cannot be used for new quotes.');
    }
    return template;
  }

  /** Names the template a quote now has, for the screen. */
  private named(input: QuoteInput, name: string | null): QuoteInput {
    return { ...input, templateName: name };
  }

  private summarise(
    plan: SwapPlan,
    nameOf: (id: string) => string,
    fromName: string | null,
    toName: string | null,
    finish: (input: QuoteInput) => QuoteInput,
  ): SwapSummary {
    const keptSections = new Set(plan.additions.sections.map((section) => section.id));
    return {
      kind: plan.kind,
      replacedLines: plan.replacedLines,
      replacedSections: plan.replacedSections,
      additions: {
        items: plan.additions.lines
          .filter((line) => line.sectionId == null || !keptSections.has(line.sectionId))
          .map((line, at) => ({
            key: `${line.productId}:${String(at)}`,
            name: nameOf(line.productId),
          })),
        sections: plan.additions.sections.map((section) => ({
          key: section.id,
          title: section.title,
          items: plan.additions.lines.filter((line) => line.sectionId === section.id).length,
        })),
      },
      edited: plan.edited.map((line, at) => ({
        key: `${line.productId}:${String(at)}`,
        name: nameOf(line.productId),
      })),
      keep: finish(plan.apply(true)),
      drop: finish(plan.apply(false)),
      toName,
      fromName,
    };
  }

  /** Switching the quote's own template (or removing it, with a null `templateId`). */
  async planQuoteSwap(raw: unknown, templateId: string | null): Promise<SwapSummary> {
    const input = parseQuoteForm(raw);
    const current = input.templateId ?? null;
    if (templateId === current) throw new Error('That template is already on this quote.');
    const [from, to] = await Promise.all([
      current === null ? null : this.quotes.getTemplate(current),
      templateId === null ? null : this.quoteTemplate(templateId, current),
    ]);
    const { priceOf, nameOf } = await this.priceLookup([
      ...input.lines.map((line) => line.productId),
      ...(from?.lines.map((line) => line.productId ?? '') ?? []),
      ...(to?.lines.map((line) => line.productId ?? '') ?? []),
    ]);
    const plan = planTemplateSwap(input, from, to, priceOf);
    const summary = this.summarise(plan, nameOf, from?.name ?? null, to?.name ?? null, (next) =>
      this.named(next, to?.name ?? null),
    );
    // Nothing to replace and no customer chosen yet: the form simply becomes the template's, with
    // the customer and addresses the template names.
    const hasName = typeof input.customerName === 'string' && input.customerName !== '';
    if (summary.kind === 'none' && to !== null && !hasName && input.customerId == null) {
      const draft = await this.draftFromTemplate(to.id, input);
      return { ...summary, keep: draft, drop: draft };
    }
    return summary;
  }

  /**
   * Starting a new quote from a template: the template's items, sections and defaults, with the
   * customer and addresses it names, or those of the customer already on the form.
   */
  async draftFromTemplate(templateId: string, base: unknown): Promise<QuoteInput> {
    const to = await this.quoteTemplate(templateId, null);
    const form = base === undefined ? undefined : parseQuoteForm(base);
    const { priceOf } = await this.priceLookup(to.lines.map((line) => line.productId ?? ''));
    const content = templateContent(to, priceOf);
    const customerId = form?.customerId ?? to.customerId;
    const customer =
      customerId == null
        ? null
        : ((
            await getContainer().customers.getCustomer(
              (await getContainer().companySettings.ensureSeeded()).id,
              customerId,
            )
          )?.customer ?? null);
    const address: Record<string, string> = customer
      ? {
          street: customer.street ?? '',
          city: customer.city ?? '',
          countyOrState: customer.countyOrState ?? '',
          postalCode: customer.postalCode ?? '',
          country: customer.country ?? 'Kenya',
        }
      : {};
    const hasCustomer = form !== undefined && (form.customerName !== '' || form.customerId != null);
    return {
      ...(form ?? ({} as QuoteInput)),
      customerId: hasCustomer ? (form.customerId ?? null) : (customer?.id ?? null),
      customerName: hasCustomer ? form.customerName : (customer?.name ?? ''),
      customerEmail: hasCustomer ? form.customerEmail : (customer?.email ?? ''),
      customerPhone: hasCustomer ? form.customerPhone : (customer?.phone ?? ''),
      billingAddress: hasCustomer
        ? form.billingAddress
        : this.addressOf(to.billingAddress, address),
      deliveryAddress: hasCustomer
        ? form.deliveryAddress
        : this.addressOf(to.deliveryAddress, address),
      currency: to.currency,
      paymentMethod: to.paymentMethod as QuoteInput['paymentMethod'],
      paymentTerms: to.paymentTerms,
      paymentDetails: to.paymentDetails,
      termsAndConditions: to.termsAndConditions,
      showBillingAddress: to.showBillingAddress,
      templateId: to.id,
      templateName: to.name,
      validUntil: new Date(Date.now() + to.validityDays * 86_400_000).toISOString().slice(0, 10),
      publicNotes: to.publicNotes,
      internalNotes: to.internalNotes,
      discountPercent: Number(to.quoteDiscountPercent),
      shippingFee: Number(to.shippingFee),
      couponCodes: form?.couponCodes ?? [],
      ...content,
    };
  }

  /** The newest default template's draft, for a new quote; null when none is set. */
  async defaultDraft(): Promise<QuoteInput | null> {
    const templates = await this.quotes.listTemplates(false);
    const chosen = templates.find((template) => template.isDefault);
    return chosen ? await this.draftFromTemplate(chosen.id, undefined) : null;
  }

  /** A new section on the form, made from a section template. */
  async addSection(raw: unknown, templateId: string): Promise<QuoteInput> {
    const input = parseQuoteForm(raw);
    const template = await this.usableSectionTemplate(templateId, input, null);
    const { priceOf } = await this.priceLookup(template.lines.map((line) => line.productId ?? ''));
    const next = addSectionFromTemplate(input, template, priceOf);
    return {
      ...next,
      sections: next.sections.map((section) =>
        section.sectionTemplateId === template.id && section.sectionTemplateName === undefined
          ? { ...section, sectionTemplateName: template.name }
          : section,
      ),
    };
  }

  private async usableSectionTemplate(
    id: string,
    input: QuoteInput,
    currentOnSection: string | null,
  ) {
    const template = await this.sectionTemplates.get(id);
    if (!template) throw new Error('The selected section template is no longer available.');
    const inUse =
      currentOnSection === template.id ||
      input.sections.some((section) => section.sectionTemplateId === template.id);
    if (template.status === 'archived' && !inUse) {
      throw new Error('Archived section templates cannot be used for new sections.');
    }
    return template;
  }

  /** Switching one section's template (or removing it, with a null `templateId`). */
  async planSectionSwap(
    raw: unknown,
    sectionId: string,
    templateId: string | null,
  ): Promise<SwapSummary> {
    const input = parseQuoteForm(raw);
    const section = input.sections.find((row) => row.id === sectionId);
    if (!section) throw new Error('That section is no longer on the quote.');
    const current = section.sectionTemplateId ?? null;
    if (templateId === current) throw new Error('That template is already on this section.');
    const [from, to] = await Promise.all([
      current === null ? null : this.sectionTemplates.get(current),
      templateId === null ? null : this.usableSectionTemplate(templateId, input, current),
    ]);
    const { priceOf, nameOf } = await this.priceLookup([
      ...input.lines.map((line) => line.productId),
      ...(from?.lines.map((line) => line.productId ?? '') ?? []),
      ...(to?.lines.map((line) => line.productId ?? '') ?? []),
    ]);
    const plan = planSectionSwap(input, sectionId, from, to, priceOf);
    const finish = (next: QuoteInput): QuoteInput => ({
      ...next,
      sections: next.sections.map((row) =>
        row.id === sectionId ? { ...row, sectionTemplateName: to?.name ?? null } : row,
      ),
    });
    return this.summarise(plan, nameOf, from?.name ?? null, to?.name ?? null, finish);
  }
}
