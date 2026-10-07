import { and, desc, eq, sql } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { withAfterCommit } from '@/server/kernel/after-commit';
import { getContainer } from '@/server/di/container';
import { drizzleDb } from '@/server/db/drizzle/client';
import {
  salesQuoteEvents,
  salesQuoteLines,
  salesQuotes,
  salesQuoteSettings,
  salesQuoteTemplateEvents,
  salesQuoteTemplateLines,
  salesQuoteTemplateSections,
  salesQuoteTemplates,
  salesQuoteSections,
  type SalesQuoteTemplateRow,
  type SalesQuoteRow,
} from '@/server/db/drizzle/schema';
import { CatalogService } from '@/server/domains/catalog/service';
import { OrderWriteService } from '@/server/domains/orders/write-service';
import type { CompanyProfile } from '@/server/ports/communications';
import { broadcastRealtime } from '@/server/realtime';
import type { PaymentProvider } from '@/types/index';

const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (value: string | number | null | undefined) => Number(value ?? 0);
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export type QuoteStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'sent'
  | 'accepted'
  | 'rejected'
  | 'expired'
  | 'converted'
  | 'cancelled';

export interface QuoteInput {
  customerId?: string | null;
  customerName: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  billingAddress?: Record<string, string>;
  deliveryAddress?: Record<string, string>;
  currency: string;
  paymentMethod: PaymentProvider;
  paymentTerms?: string | null;
  templateId?: string | null;
  showBillingAddress?: boolean;
  paymentDetails?: string | null;
  termsAndConditions?: string | null;
  validUntil?: string | null;
  customerReference?: string | null;
  publicNotes?: string | null;
  internalNotes?: string | null;
  discountPercent: number;
  shippingFee: number;
  sections: { id: string; title: string; description?: string | null }[];
  lines: {
    sectionId?: string | null;
    productId: string;
    quantity: number;
    unitPrice?: number;
    /**
     * How the unit price is decided. `catalog`: priced from the price lists now. `manual`: the
     * typed `unitPrice`. `kept`: the price already saved on this quote, with its explanation.
     * Without it, a typed `unitPrice` is manual and no price at all is catalog.
     */
    priceMode?: 'catalog' | 'manual' | 'kept';
    discountPercent: number;
  }[];
}

export interface SalesQuote extends SalesQuoteRow {
  lines: (typeof salesQuoteLines.$inferSelect)[];
  sections: (typeof salesQuoteSections.$inferSelect)[];
  events: (typeof salesQuoteEvents.$inferSelect)[];
}

export interface QuoteTemplateInput {
  name: string;
  category?: string | null;
  description?: string | null;
  customerId?: string | null;
  currency: string;
  paymentMethod: PaymentProvider;
  paymentTerms?: string | null;
  paymentDetails?: string | null;
  termsAndConditions?: string | null;
  showBillingAddress: boolean;
  validityDays: number;
  quoteDiscountPercent: number;
  shippingFee: number;
  billingAddress?: Record<string, string>;
  deliveryAddress?: Record<string, string>;
  publicNotes?: string | null;
  internalNotes?: string | null;
  tags: string[];
  isDefault: boolean;
  sections: { id: string; title: string; description?: string | null }[];
  lines: {
    sectionId?: string | null;
    productId: string;
    quantity: number;
    priceMode: 'catalog' | 'fixed';
    unitPrice?: number | null;
    discountPercent: number;
  }[];
}

export interface SalesQuoteTemplate extends SalesQuoteTemplateRow {
  lines: (typeof salesQuoteTemplateLines.$inferSelect)[];
  sections: (typeof salesQuoteTemplateSections.$inferSelect)[];
  events: (typeof salesQuoteTemplateEvents.$inferSelect)[];
}

export class SalesQuoteService {
  private async companyId() {
    return (await getContainer().companySettings.ensureSeeded()).id;
  }

  async getSettings(companyId?: string) {
    const resolvedCompanyId = companyId ?? (await this.companyId());
    const [setting] = await drizzleDb
      .select()
      .from(salesQuoteSettings)
      .where(eq(salesQuoteSettings.companyId, resolvedCompanyId))
      .limit(1);
    return (
      setting ?? {
        companyId: resolvedCompanyId,
        minimumGrossMarginPercent: '0',
        nextQuoteNumber: 1,
        updatedBy: null,
        updatedAt: new Date(),
      }
    );
  }

  async updateSettings(userId: string, minimumGrossMarginPercent: number) {
    if (
      !Number.isFinite(minimumGrossMarginPercent) ||
      minimumGrossMarginPercent < 0 ||
      minimumGrossMarginPercent > 100
    ) {
      throw new Error('Minimum gross margin must be between 0 and 100%.');
    }
    const companyId = await this.companyId();
    const [row] = await drizzleDb
      .insert(salesQuoteSettings)
      .values({
        companyId,
        minimumGrossMarginPercent: minimumGrossMarginPercent.toFixed(3),
        updatedBy: userId,
      })
      .onConflictDoUpdate({
        target: salesQuoteSettings.companyId,
        set: {
          minimumGrossMarginPercent: minimumGrossMarginPercent.toFixed(3),
          updatedBy: userId,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row!;
  }

  async listTemplates(includeArchived = true): Promise<SalesQuoteTemplate[]> {
    const companyId = await this.companyId();
    const rows = await drizzleDb
      .select()
      .from(salesQuoteTemplates)
      .where(
        includeArchived
          ? eq(salesQuoteTemplates.companyId, companyId)
          : and(
              eq(salesQuoteTemplates.companyId, companyId),
              eq(salesQuoteTemplates.status, 'active'),
            ),
      )
      .orderBy(desc(salesQuoteTemplates.isDefault), desc(salesQuoteTemplates.updatedAt));
    return Promise.all(rows.map((row) => this.getTemplate(row.id) as Promise<SalesQuoteTemplate>));
  }

  async getTemplate(id: string): Promise<SalesQuoteTemplate | null> {
    const companyId = await this.companyId();
    const [template] = await drizzleDb
      .select()
      .from(salesQuoteTemplates)
      .where(and(eq(salesQuoteTemplates.id, id), eq(salesQuoteTemplates.companyId, companyId)))
      .limit(1);
    if (!template) return null;
    const [lines, sections, events] = await Promise.all([
      drizzleDb
        .select()
        .from(salesQuoteTemplateLines)
        .where(eq(salesQuoteTemplateLines.templateId, id))
        .orderBy(salesQuoteTemplateLines.lineNumber),
      drizzleDb
        .select()
        .from(salesQuoteTemplateSections)
        .where(eq(salesQuoteTemplateSections.templateId, id))
        .orderBy(salesQuoteTemplateSections.sectionNumber),
      drizzleDb
        .select()
        .from(salesQuoteTemplateEvents)
        .where(eq(salesQuoteTemplateEvents.templateId, id))
        .orderBy(desc(salesQuoteTemplateEvents.createdAt)),
    ]);
    return {
      ...template,
      lines,
      sections,
      events,
    };
  }

  async saveTemplate(userId: string, id: string | null, input: QuoteTemplateInput) {
    const companyId = await this.companyId();
    const name = input.name.trim();
    if (!name) throw new Error('Template name is required.');
    this.assertPercent(input.quoteDiscountPercent, 'Template quote discount');
    if (
      !Number.isInteger(input.validityDays) ||
      input.validityDays < 1 ||
      input.validityDays > 3650
    ) {
      throw new Error('Template validity must be between 1 and 3,650 days.');
    }
    if (!Number.isFinite(input.shippingFee) || input.shippingFee < 0) {
      throw new Error('Template shipping must be zero or greater.');
    }
    const existing = id ? await this.getTemplate(id) : null;
    if (id && !existing) throw new Error('Quote template not found.');
    if (input.lines.length === 0) throw new Error('Add at least one product to the template.');
    const products = new Map(
      (await CatalogService.getProductsByIds(input.lines.map((line) => line.productId))).map(
        (p) => [p.id, p],
      ),
    );
    const sections = input.sections ?? [];
    const sectionIds = new Set(sections.map((section) => section.id));
    if (sections.some((section) => !section.title.trim())) {
      throw new Error('Every quote template section needs a title.');
    }
    const lines = input.lines.map((line, index) => {
      const product = products.get(line.productId);
      if (!product || !product.isSellable)
        throw new Error('A template item is missing or is not sellable.');
      if (!Number.isFinite(line.quantity) || line.quantity <= 0)
        throw new Error(`${product.name} needs a quantity greater than zero.`);
      this.assertPercent(line.discountPercent, `${product.name} discount`);
      if (line.sectionId && !sectionIds.has(line.sectionId)) {
        throw new Error(`${product.name} references a section that no longer exists.`);
      }
      const unitPrice = line.priceMode === 'fixed' ? line.unitPrice : null;
      if (line.priceMode === 'fixed' && (!Number.isFinite(unitPrice) || Number(unitPrice) < 0)) {
        throw new Error(`${product.name} needs a valid fixed selling price.`);
      }
      return {
        productId: product.id,
        sectionId: line.sectionId || null,
        lineNumber: (index + 1) * 10000,
        sku: product.sku,
        description: product.name,
        quantity: line.quantity.toFixed(3),
        priceMode: line.priceMode,
        unitPrice: unitPrice == null ? null : Number(unitPrice).toFixed(4),
        discountPercent: line.discountPercent.toFixed(3),
      };
    });

    const saved = await drizzleDb.transaction(async (tx) => {
      if (input.isDefault) {
        await tx
          .update(salesQuoteTemplates)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(eq(salesQuoteTemplates.companyId, companyId));
      }
      const values = {
        companyId,
        customerId: input.customerId || null,
        name,
        category: input.category?.trim() || null,
        description: input.description?.trim() || null,
        status: 'active',
        isDefault: input.isDefault,
        tags: [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))],
        currency: input.currency.trim().toUpperCase(),
        paymentMethod: input.paymentMethod,
        paymentTerms: input.paymentTerms?.trim() || null,
        paymentDetails: input.paymentDetails?.trim() || null,
        termsAndConditions: input.termsAndConditions?.trim() || null,
        showBillingAddress:
          input.showBillingAddress === true &&
          Object.values(input.billingAddress ?? {}).some((value) => value.trim().length > 0),
        validityDays: input.validityDays,
        quoteDiscountPercent: input.quoteDiscountPercent.toFixed(3),
        shippingFee: input.shippingFee.toFixed(2),
        billingAddress: input.billingAddress ?? {},
        deliveryAddress: input.deliveryAddress ?? {},
        publicNotes: input.publicNotes?.trim() || null,
        internalNotes: input.internalNotes?.trim() || null,
        updatedBy: userId,
        updatedAt: new Date(),
      };
      let template: SalesQuoteTemplateRow;
      if (existing) {
        const [updated] = await tx
          .update(salesQuoteTemplates)
          .set(values)
          .where(eq(salesQuoteTemplates.id, existing.id))
          .returning();
        if (!updated) throw new Error('Template changed while editing. Refresh and try again.');
        template = updated;
        await tx
          .delete(salesQuoteTemplateLines)
          .where(eq(salesQuoteTemplateLines.templateId, template.id));
        await tx
          .delete(salesQuoteTemplateSections)
          .where(eq(salesQuoteTemplateSections.templateId, template.id));
      } else {
        const [created] = await tx
          .insert(salesQuoteTemplates)
          .values({ ...values, createdBy: userId })
          .returning();
        template = created!;
      }
      if (sections.length) {
        await tx.insert(salesQuoteTemplateSections).values(
          sections.map((section, index) => ({
            id: section.id,
            templateId: template.id,
            sectionNumber: (index + 1) * 10000,
            title: section.title.trim(),
            description: section.description?.trim() || null,
          })),
        );
      }
      await tx
        .insert(salesQuoteTemplateLines)
        .values(lines.map((line) => ({ ...line, templateId: template.id })));
      await tx.insert(salesQuoteTemplateEvents).values({
        templateId: template.id,
        eventType: existing ? 'updated' : 'created',
        actorId: userId,
        details: { lineCount: lines.length, isDefault: input.isDefault },
      });
      return template;
    });
    await broadcastRealtime('quote_event', {
      templateId: saved.id,
      type: existing ? 'template_updated' : 'template_created',
    });
    return (await this.getTemplate(saved.id))!;
  }

  async duplicateTemplate(userId: string, id: string) {
    const original = await this.getTemplate(id);
    if (!original) throw new Error('Quote template not found.');
    const names = new Set(
      (await this.listTemplates()).map((template) => template.name.toLowerCase()),
    );
    const copiedSectionIds = new Map(
      original.sections.map((section) => [section.id, randomUUID()]),
    );
    let name = `${original.name} (Copy)`;
    for (let copy = 2; names.has(name.toLowerCase()); copy += 1)
      name = `${original.name} (Copy ${copy})`;
    return this.saveTemplate(userId, null, {
      name,
      category: original.category,
      description: original.description,
      customerId: original.customerId,
      currency: original.currency,
      paymentMethod: original.paymentMethod as PaymentProvider,
      paymentTerms: original.paymentTerms,
      paymentDetails: original.paymentDetails,
      termsAndConditions: original.termsAndConditions,
      showBillingAddress: original.showBillingAddress,
      validityDays: original.validityDays,
      quoteDiscountPercent: num(original.quoteDiscountPercent),
      shippingFee: num(original.shippingFee),
      billingAddress: original.billingAddress,
      deliveryAddress: original.deliveryAddress,
      publicNotes: original.publicNotes,
      internalNotes: original.internalNotes,
      tags: original.tags,
      isDefault: false,
      sections: original.sections.map((section) => ({
        id: copiedSectionIds.get(section.id)!,
        title: section.title,
        description: section.description,
      })),
      lines: original.lines.map((line) => ({
        sectionId: line.sectionId ? (copiedSectionIds.get(line.sectionId) ?? null) : null,
        productId: line.productId ?? '',
        quantity: num(line.quantity),
        priceMode: line.priceMode as 'catalog' | 'fixed',
        unitPrice: line.unitPrice == null ? null : num(line.unitPrice),
        discountPercent: num(line.discountPercent),
      })),
    });
  }

  async archiveTemplate(userId: string, id: string) {
    const existing = await this.getTemplate(id);
    if (!existing) throw new Error('Quote template not found.');
    await drizzleDb
      .update(salesQuoteTemplates)
      .set({ status: 'archived', isDefault: false, updatedBy: userId, updatedAt: new Date() })
      .where(eq(salesQuoteTemplates.id, id));
    await this.templateEvent(id, 'archived', userId, {});
    await broadcastRealtime('quote_event', { templateId: id, type: 'template_archived' });
  }

  async setDefaultTemplate(userId: string, id: string) {
    const companyId = await this.companyId();
    const template = await this.getTemplate(id);
    if (!template || template.status !== 'active') throw new Error('Choose an active template.');
    await drizzleDb.transaction(async (tx) => {
      await tx
        .update(salesQuoteTemplates)
        .set({ isDefault: false, updatedBy: userId, updatedAt: new Date() })
        .where(eq(salesQuoteTemplates.companyId, companyId));
      await tx
        .update(salesQuoteTemplates)
        .set({ isDefault: true, updatedBy: userId, updatedAt: new Date() })
        .where(eq(salesQuoteTemplates.id, id));
      await tx.insert(salesQuoteTemplateEvents).values({
        templateId: id,
        eventType: 'set_as_default',
        actorId: userId,
        details: {},
      });
    });
    await broadcastRealtime('quote_event', { templateId: id, type: 'template_default_changed' });
  }

  async list() {
    const companyId = await this.companyId();
    const rows = await drizzleDb
      .select()
      .from(salesQuotes)
      .where(eq(salesQuotes.companyId, companyId))
      .orderBy(desc(salesQuotes.updatedAt))
      .limit(500);
    return rows;
  }

  async get(id: string): Promise<SalesQuote | null> {
    const companyId = await this.companyId();
    const [quote] = await drizzleDb
      .select()
      .from(salesQuotes)
      .where(and(eq(salesQuotes.id, id), eq(salesQuotes.companyId, companyId)))
      .limit(1);
    if (!quote) return null;
    const [lines, sections, events] = await Promise.all([
      drizzleDb
        .select()
        .from(salesQuoteLines)
        .where(eq(salesQuoteLines.quoteId, quote.id))
        .orderBy(salesQuoteLines.lineNumber),
      drizzleDb
        .select()
        .from(salesQuoteSections)
        .where(eq(salesQuoteSections.quoteId, quote.id))
        .orderBy(salesQuoteSections.sectionNumber),
      drizzleDb
        .select()
        .from(salesQuoteEvents)
        .where(eq(salesQuoteEvents.quoteId, quote.id))
        .orderBy(desc(salesQuoteEvents.createdAt)),
    ]);
    return {
      ...quote,
      lines,
      sections,
      events,
    };
  }

  async create(userId: string, input: QuoteInput): Promise<SalesQuote> {
    return this.save(userId, null, input);
  }

  async update(userId: string, id: string, input: QuoteInput): Promise<SalesQuote> {
    return this.save(userId, id, input);
  }

  async revise(userId: string, id: string): Promise<SalesQuote> {
    const previous = await this.get(id);
    if (!previous) throw new Error('Quote not found.');
    if (previous.status === 'converted' || previous.status === 'cancelled') {
      throw new Error('A converted or cancelled quote cannot be revised.');
    }
    const revisedSections = previous.sections.map((section) => ({
      id: randomUUID(),
      sourceId: section.id,
      title: section.title,
      description: section.description,
    }));
    const revised = await this.create(userId, {
      customerId: previous.customerId,
      customerName: previous.customerName,
      customerEmail: previous.customerEmail,
      customerPhone: previous.customerPhone,
      billingAddress: previous.billingAddress,
      deliveryAddress: previous.deliveryAddress,
      currency: previous.currency,
      paymentMethod: previous.paymentMethod as PaymentProvider,
      paymentTerms: previous.paymentTerms,
      templateId: previous.templateId,
      showBillingAddress: previous.showBillingAddress,
      paymentDetails: previous.paymentDetails,
      termsAndConditions: previous.termsAndConditions,
      validUntil: previous.validUntil?.toISOString().slice(0, 10),
      customerReference: previous.customerReference,
      publicNotes: previous.publicNotes,
      internalNotes: previous.internalNotes,
      discountPercent: num(previous.quoteDiscountPercent),
      shippingFee: num(previous.shippingFee),
      sections: revisedSections,
      lines: previous.lines.map((line) => ({
        sectionId: line.sectionId
          ? revisedSections.find((section) => section.sourceId === line.sectionId)?.id
          : null,
        productId: line.productId ?? '',
        quantity: num(line.quantity),
        unitPrice: num(line.unitPrice),
        discountPercent: num(line.discountPercent),
      })),
    });
    await drizzleDb
      .update(salesQuotes)
      .set({ revisedFromQuoteId: previous.id })
      .where(eq(salesQuotes.id, revised.id));
    await this.event(revised.id, 'revised_from', userId, {
      previousQuoteId: previous.id,
      previousQuoteNumber: previous.quoteNumber,
    });
    await this.event(previous.id, 'revision_created', userId, {
      quoteId: revised.id,
      quoteNumber: revised.quoteNumber,
    });
    return (await this.get(revised.id))!;
  }

  private async save(userId: string, id: string | null, input: QuoteInput): Promise<SalesQuote> {
    const companyId = await this.companyId();
    const settings = await this.getSettings(companyId);
    // An existing quote keeps its number; a new one is numbered by the series inside the same
    // transaction that saves it (see below), so a failed save leaves no gap.
    const existingNumber = id ? (await this.get(id))?.quoteNumber : undefined;
    if (id && !existingNumber) throw new Error('Quote not found.');

    const existing = id ? await this.get(id) : null;
    if (id && !existing) throw new Error('Quote not found.');
    if (existing && !['draft', 'pending_approval', 'approved'].includes(existing.status)) {
      throw new Error('Only draft or approved quotes can be edited.');
    }
    const sourceTemplate = input.templateId ? await this.getTemplate(input.templateId) : null;
    if (input.templateId && !sourceTemplate) {
      throw new Error('The selected quote template is no longer available.');
    }
    if (sourceTemplate?.status === 'archived' && existing?.templateId !== sourceTemplate.id) {
      throw new Error('Archived templates cannot be used for new quotes.');
    }
    const customerName = input.customerName.trim();
    if (!customerName) throw new Error('Choose a customer or enter a customer name.');
    if (!input.lines.length) throw new Error('Add at least one item to the quote.');
    if (input.lines.some((line) => !Number.isFinite(line.quantity) || line.quantity <= 0)) {
      throw new Error('Each quote line needs a quantity greater than zero.');
    }
    this.assertPercent(input.discountPercent, 'Quote discount');
    if (!Number.isFinite(input.shippingFee) || input.shippingFee < 0) {
      throw new Error('Shipping must be zero or a positive amount.');
    }

    const products = new Map(
      (await CatalogService.getProductsByIds(input.lines.map((line) => line.productId))).map(
        (p) => [p.id, p],
      ),
    );
    const sections = input.sections ?? [];
    const sectionIds = new Set(sections.map((section) => section.id));
    if (sections.some((section) => !section.title.trim())) {
      throw new Error('Every quote section needs a title.');
    }
    if (input.lines.some((line) => line.sectionId && !sectionIds.has(line.sectionId))) {
      throw new Error('A quote line references a section that no longer exists.');
    }
    const { branch } = await getContainer().organizations.ensureDefaultOrgAndBranch(
      companyId,
      (await getContainer().companySettings.getProfile()).tradingName,
    );
    // Lines priced from the price lists, and lines whose saved price is being kept. Amounts are in
    // the base currency, as they were before price lists existed.
    const modes = input.lines.map(
      (line) => line.priceMode ?? (line.unitPrice != null ? 'manual' : 'catalog'),
    );
    const toPrice = input.lines.flatMap((line, i) => {
      const product = products.get(line.productId);
      return modes[i] === 'catalog' && product && product.isSellable !== false ? [i] : [];
    });
    const priced = await getContainer().pricing.priceLines(
      companyId,
      {
        customerId: input.customerId || null,
        branchId: branch.id,
        salesType: input.paymentMethod === 'on_account' ? 'credit' : 'cash',
        channel: 'sales_order',
      },
      toPrice.map((i) => {
        const line = input.lines[i]!;
        const product = products.get(line.productId)!;
        const inclusive = product.isTaxInclusive !== false;
        return {
          productId: line.productId,
          quantity: line.quantity,
          standardPrice: product.price ?? null,
          taxRate: Math.max(0, product.taxRate ?? 0),
          lineTaxInclusive: inclusive,
          standardTaxInclusive: inclusive,
        };
      }),
    );
    const engine = new Map(toPrice.map((i, n) => [i, priced[n]!]));
    const keptFrom = new Set<string>();
    let subtotal = 0;
    let taxAmount = 0;
    let discountAmount = 0;
    let totalCost = 0;
    const lines = input.lines.map((line, index) => {
      const product = products.get(line.productId);
      if (!product || product.isSellable === false)
        throw new Error('A selected item is no longer sellable.');
      const result = engine.get(index);
      if (result && result.unitPrice == null) {
        throw new Error(
          `${product.name} cannot be priced. ${result.trace.steps.at(-1) ?? ''}`.trim(),
        );
      }
      let priceTrace = result?.trace ?? null;
      if (modes[index] === 'kept' && line.unitPrice != null) {
        // Keep the saved price and its explanation, but only if it really is what was saved.
        const was = existing?.lines.find(
          (l) =>
            !keptFrom.has(l.id) &&
            l.productId === line.productId &&
            Number(l.unitPrice) === Number(line.unitPrice),
        );
        if (was) {
          keptFrom.add(was.id);
          priceTrace = was.priceTrace ?? null;
        }
      }
      const unitPrice = result ? result.unitPrice : (line.unitPrice ?? product.price);
      if (unitPrice == null || !Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new Error(`${product.name} needs a valid selling price.`);
      }
      this.assertPercent(line.discountPercent, `${product.name} discount`);
      const beforeDiscount = unitPrice * line.quantity;
      const discountedGross =
        beforeDiscount * (1 - line.discountPercent / 100) * (1 - input.discountPercent / 100);
      const rate = Math.max(0, product.taxRate ?? 0);
      const inclusive = product.isTaxInclusive !== false;
      const net = inclusive && rate > 0 ? discountedGross / (1 + rate / 100) : discountedGross;
      const tax = inclusive && rate > 0 ? discountedGross - net : net * (rate / 100);
      const lineNet = money(net);
      const lineTax = money(tax);
      const lineTotal = money(lineNet + lineTax);
      const cost = Math.max(0, product.costPrice || 0) * line.quantity;
      subtotal += lineNet;
      taxAmount += lineTax;
      discountAmount += beforeDiscount - discountedGross;
      totalCost += cost;
      return {
        productId: product.id,
        sectionId: line.sectionId || null,
        lineNumber: (index + 1) * 10000,
        sku: product.sku,
        description: product.name,
        quantity: line.quantity.toFixed(3),
        unitPrice: unitPrice.toFixed(4),
        unitCost: (product.costPrice || 0).toFixed(4),
        taxRate: rate.toFixed(3),
        isTaxInclusive: inclusive,
        discountPercent: line.discountPercent.toFixed(3),
        netAmount: lineNet.toFixed(2),
        taxAmount: lineTax.toFixed(2),
        lineAmount: lineTotal.toFixed(2),
        costAmount: money(cost).toFixed(2),
        priceTrace,
      };
    });
    subtotal = money(subtotal);
    taxAmount = money(taxAmount);
    discountAmount = money(discountAmount);
    totalCost = money(totalCost);
    const shippingFee = money(input.shippingFee);
    const totalAmount = money(subtotal + taxAmount + shippingFee);
    const grossProfit = money(subtotal - totalCost);
    const grossMarginPercent = subtotal > 0 ? (grossProfit / subtotal) * 100 : 0;
    const minimumMarginPercent = num(settings.minimumGrossMarginPercent);
    const belowFloor = grossMarginPercent < minimumMarginPercent;
    const now = new Date();
    // A configured approval workflow, if one applies, owns this quote's approval; otherwise the
    // old margin-floor check does, exactly as before.
    const approvalRequest = {
      companyId,
      trigger: 'sales_quote.submitted',
      branchId: branch.id,
      requestedBy: userId,
      amount: totalAmount,
      snapshot: {
        discountPercent: Math.max(0, ...input.lines.map((l) => l.discountPercent)),
        quoteDiscountPercent: input.discountPercent,
        marginPercent: Math.round(grossMarginPercent * 1000) / 1000,
        belowFloor,
        customer: { id: input.customerId || null },
      },
    };
    const byWorkflow = await getContainer().approvals.wouldRequire({
      ...approvalRequest,
      documentId: id ?? 'new',
    });
    const approvalStatus = byWorkflow || belowFloor ? 'pending' : 'not_required';
    const status: QuoteStatus = byWorkflow || belowFloor ? 'pending_approval' : 'draft';
    const deliveryAddress = input.deliveryAddress ?? {};
    const header = {
      companyId,
      branchId: branch.id,
      customerId: input.customerId || null,
      templateId: sourceTemplate?.id ?? null,
      templateName: sourceTemplate?.name ?? null,
      quoteNumber: existingNumber ?? '',
      status,
      customerName,
      customerEmail: input.customerEmail?.trim().toLowerCase() || null,
      customerPhone: input.customerPhone?.trim() || null,
      billingAddress: input.billingAddress ?? {},
      deliveryAddress,
      currency: input.currency.trim().toUpperCase(),
      subtotal: subtotal.toFixed(2),
      taxAmount: taxAmount.toFixed(2),
      discountAmount: discountAmount.toFixed(2),
      quoteDiscountPercent: input.discountPercent.toFixed(3),
      shippingFee: shippingFee.toFixed(2),
      totalAmount: totalAmount.toFixed(2),
      totalCost: totalCost.toFixed(2),
      grossProfit: grossProfit.toFixed(2),
      grossMarginPercent: grossMarginPercent.toFixed(3),
      minimumMarginPercent: minimumMarginPercent.toFixed(3),
      approvalStatus,
      approvalManagedBy: byWorkflow ? 'workflow' : null,
      paymentMethod: input.paymentMethod,
      paymentTerms: input.paymentTerms?.trim() || null,
      showBillingAddress:
        input.showBillingAddress === true &&
        Object.values(input.billingAddress ?? {}).some((value) => value.trim().length > 0),
      paymentDetails: input.paymentDetails?.trim() || null,
      termsAndConditions: input.termsAndConditions?.trim() || null,
      validUntil: input.validUntil ? new Date(`${input.validUntil}T23:59:59`) : null,
      customerReference: input.customerReference?.trim() || null,
      publicNotes: input.publicNotes?.trim() || null,
      internalNotes: input.internalNotes?.trim() || null,
      updatedAt: now,
    };

    const saved = await drizzleDb.transaction(async (tx) => {
      let quote: SalesQuoteRow;
      if (existing) {
        const [updated] = await tx
          .update(salesQuotes)
          .set({
            ...header,
            status:
              existing.status === 'approved' && !belowFloor && !byWorkflow ? 'approved' : status,
          })
          .where(eq(salesQuotes.id, existing.id))
          .returning();
        if (!updated) throw new Error('Quote was changed by another user. Refresh and try again.');
        quote = updated;
        await tx.delete(salesQuoteLines).where(eq(salesQuoteLines.quoteId, quote.id));
        await tx.delete(salesQuoteSections).where(eq(salesQuoteSections.quoteId, quote.id));
      } else {
        const quoteId = randomUUID();
        const { number } = await getContainer().numbering.assign(
          'sales_quote',
          {
            companyId,
            branchId: header.branchId,
            date: businessDate(),
            document: { kind: 'sales_quote', id: quoteId },
            actor: { type: 'user', id: userId },
          },
          tx,
        );
        const [created] = await tx
          .insert(salesQuotes)
          .values({ ...header, id: quoteId, quoteNumber: number, createdBy: userId })
          .returning();
        quote = created!;
      }
      if (sections.length) {
        await tx.insert(salesQuoteSections).values(
          sections.map((section, index) => ({
            id: section.id,
            quoteId: quote.id,
            sectionNumber: (index + 1) * 10000,
            title: section.title.trim(),
            description: section.description?.trim() || null,
          })),
        );
      }
      await tx
        .insert(salesQuoteLines)
        .values(lines.map((line) => ({ ...line, quoteId: quote.id })));
      // Whatever was being approved is not what is saved now: close it out, then ask afresh.
      if (existing) {
        await getContainer().approvals.supersedePending(
          companyId,
          'sales_quote',
          quote.id,
          { userId },
          'The quote was edited.',
          tx,
          // Edited so that no workflow applies any more: an earlier refusal no longer matters.
          !byWorkflow,
        );
      }
      if (byWorkflow) {
        const outcome = await getContainer().approvals.submit(
          { ...approvalRequest, documentId: quote.id },
          tx,
        );
        if (!outcome.required) {
          // Nothing applies after all (the rules changed a moment ago): fall back to the margin check.
          await tx
            .update(salesQuotes)
            .set({
              approvalManagedBy: null,
              approvalStatus: belowFloor ? 'pending' : 'not_required',
              status: belowFloor ? 'pending_approval' : 'draft',
            })
            .where(eq(salesQuotes.id, quote.id));
        }
      }
      await tx.insert(salesQuoteEvents).values({
        quoteId: quote.id,
        eventType: existing ? 'updated' : 'created',
        actorId: userId,
        details: {
          status,
          grossMarginPercent: Number(grossMarginPercent.toFixed(3)),
          minimumMarginPercent,
          approvalRequired: belowFloor || byWorkflow,
          approvalByWorkflow: byWorkflow,
        },
      });
      if (!existing && sourceTemplate) {
        await tx
          .update(salesQuoteTemplates)
          .set({ usageCount: sql`${salesQuoteTemplates.usageCount} + 1`, updatedAt: now })
          .where(eq(salesQuoteTemplates.id, sourceTemplate.id));
        await tx.insert(salesQuoteTemplateEvents).values({
          templateId: sourceTemplate.id,
          eventType: 'used',
          actorId: userId,
          details: { quoteId: quote.id, quoteNumber: quote.quoteNumber },
        });
      }
      return quote;
    });
    return (await this.get(saved.id))!;
  }

  /** Sends a reopened quote back for approval, as it is now (the same as saving it again). */
  async resubmitApproval(userId: string, id: string): Promise<SalesQuote> {
    const quote = await this.get(id);
    if (!quote) throw new Error('Quote not found.');
    if (quote.approvalStatus !== 'draft' || quote.approvalManagedBy !== 'workflow') {
      throw new Error('This quote is not waiting to be sent for approval again.');
    }
    const margin = num(quote.grossMarginPercent);
    const belowFloor = margin < num(quote.minimumMarginPercent);
    const request = {
      companyId: quote.companyId,
      trigger: 'sales_quote.submitted',
      branchId: quote.branchId,
      requestedBy: userId,
      amount: num(quote.totalAmount),
      snapshot: {
        discountPercent: Math.max(0, ...quote.lines.map((l) => num(l.discountPercent))),
        quoteDiscountPercent: num(quote.quoteDiscountPercent),
        marginPercent: Math.round(margin * 1000) / 1000,
        belowFloor,
        customer: { id: quote.customerId },
      },
    };
    const { approvals } = getContainer();
    await withAfterCommit(drizzleDb, async (tx) => {
      const outcome = await approvals.submit({ ...request, documentId: quote.id }, tx);
      const held = outcome.required && !outcome.released;
      if (held) {
        await tx
          .update(salesQuotes)
          .set({ status: 'pending_approval', approvalStatus: 'pending', updatedAt: new Date() })
          .where(eq(salesQuotes.id, quote.id));
      } else if (!outcome.required) {
        // Nothing needs approving any more: fall back to the margin check.
        await tx
          .update(salesQuotes)
          .set({
            approvalManagedBy: null,
            status: belowFloor ? 'pending_approval' : 'draft',
            approvalStatus: belowFloor ? 'pending' : 'not_required',
            updatedAt: new Date(),
          })
          .where(eq(salesQuotes.id, quote.id));
      }
    });
    await this.event(id, 'approval_resubmitted', userId, {});
    return (await this.get(id))!;
  }

  async approve(userId: string, id: string) {
    const quote = await this.get(id);
    if (!quote) throw new Error('Quote not found.');
    if (quote.status !== 'pending_approval')
      throw new Error('This quote is not awaiting approval.');
    if (quote.approvalManagedBy === 'workflow') {
      throw new Error(
        'This quote is approved through the Approvals inbox, by the approvers set for it.',
      );
    }
    const [updated] = await drizzleDb
      .update(salesQuotes)
      .set({
        status: 'approved',
        approvalStatus: 'approved',
        approvedBy: userId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(salesQuotes.id, id), eq(salesQuotes.status, 'pending_approval')))
      .returning();
    if (!updated) throw new Error('Quote state changed. Refresh and try again.');
    await this.event(id, 'approved', userId, { approvedBelowFloor: true });
    return this.get(id);
  }

  async changeStatus(id: string, userId: string, status: 'accepted' | 'rejected' | 'cancelled') {
    const quote = await this.get(id);
    if (!quote) throw new Error('Quote not found.');
    const allowed: Record<typeof status, QuoteStatus[]> = {
      accepted: ['sent'],
      rejected: ['sent'],
      cancelled: ['draft', 'pending_approval', 'approved', 'sent', 'accepted'],
    };
    if (!allowed[status].includes(quote.status as QuoteStatus)) {
      throw new Error(`A ${quote.status} quote cannot be marked ${status}.`);
    }
    const patch = {
      status,
      updatedAt: new Date(),
      ...(status === 'accepted' ? { acceptedAt: new Date() } : {}),
      ...(status === 'rejected' ? { rejectedAt: new Date() } : {}),
    };
    await drizzleDb.update(salesQuotes).set(patch).where(eq(salesQuotes.id, id));
    await this.event(id, status, userId, {});
    if (status === 'accepted') {
      try {
        await this.convertToOrder(userId, id);
      } catch (error) {
        await this.event(id, 'order_conversion_failed', userId, {
          error: error instanceof Error ? error.message : 'Order conversion failed',
        });
      }
    }
    return this.get(id);
  }

  async convertToOrder(userId: string, id: string) {
    let quote = await this.get(id);
    if (!quote) throw new Error('Quote not found.');
    if (quote.convertedOrderId) return getContainer().orders.getById(quote.convertedOrderId);
    const orderId = `ord_quote_${quote.id}`;
    const alreadyCreatedOrder = await getContainer().orders.getById(orderId);
    if (alreadyCreatedOrder) {
      await drizzleDb
        .update(salesQuotes)
        .set({
          status: 'converted',
          convertedOrderId: alreadyCreatedOrder.id,
          updatedAt: new Date(),
        })
        .where(eq(salesQuotes.id, id));
      await this.event(id, 'converted', userId, {
        orderId: alreadyCreatedOrder.id,
        orderNumber: alreadyCreatedOrder.orderNumber,
        recovered: true,
      });
      return alreadyCreatedOrder;
    }
    if (quote.status === 'converting') {
      if (Date.now() - quote.updatedAt.getTime() < 10 * 60 * 1000) {
        throw new Error(
          'This quote is already being converted. Refresh the quote in a few minutes.',
        );
      }
      await drizzleDb
        .update(salesQuotes)
        .set({ status: 'accepted', updatedAt: new Date() })
        .where(and(eq(salesQuotes.id, id), eq(salesQuotes.status, 'converting')));
      quote = (await this.get(id))!;
    }
    if (quote.status !== 'accepted')
      throw new Error('Only accepted quotes can be converted to orders.');
    if (quote.validUntil && quote.validUntil < new Date())
      throw new Error('This quote has expired.');
    const address = quote.deliveryAddress;
    if (!address.street || !address.city || !address.countyOrState || !address.country) {
      throw new Error('Add a complete delivery address to the quote before converting it.');
    }
    const items = quote.lines.map((line) => ({
      productId: line.productId ?? '',
      quantity: num(line.quantity),
    }));
    if (items.some((line) => !line.productId))
      throw new Error('A quoted product was removed from the catalog and cannot be converted.');
    const [claimed] = await drizzleDb
      .update(salesQuotes)
      .set({ status: 'converting', updatedAt: new Date() })
      .where(
        and(
          eq(salesQuotes.id, id),
          eq(salesQuotes.status, 'accepted'),
          sql`${salesQuotes.convertedOrderId} IS NULL`,
        ),
      )
      .returning({ id: salesQuotes.id });
    if (!claimed)
      throw new Error('The quote is already being processed. Refresh to see its latest status.');

    try {
      const result = await OrderWriteService.createOrder({
        orderId,
        // The order is numbered by the sales order series, once: its id is fixed, so a retried
        // conversion gets the same number back.
        // A quote only ever has a proforma; signing starts once it is a sales order.
        salesModule: 'sales_order',
        // Staff placing it: approvals (if configured) are asked on their behalf.
        requestedBy: userId,
        userId: quote.customerId,
        branchId: quote.branchId,
        customerName: quote.customerName,
        customerEmail: quote.customerEmail ?? '',
        customerPhone: quote.customerPhone ?? '',
        shippingAddress: {
          street: address.street,
          city: address.city,
          countyOrState: address.countyOrState,
          postalCode: address.postalCode,
          country: address.country,
        },
        items,
        quotedItems: quote.lines.map((line) => ({
          productId: line.productId!,
          quantity: num(line.quantity),
          productName: line.description,
          sku: line.sku,
          lineAmount: num(line.lineAmount),
          taxRate: num(line.taxRate),
          isTaxInclusive: line.isTaxInclusive,
          priceTrace: line.priceTrace ?? null,
        })),
        quotedTotals: {
          subtotal: num(quote.subtotal),
          tax: num(quote.taxAmount),
          shippingFee: num(quote.shippingFee),
          totalAmount: num(quote.totalAmount),
        },
        currency: quote.currency as 'KES' | 'USD',
        paymentMethod: quote.paymentMethod as PaymentProvider,
      });
      if (!result.success || !result.order)
        throw new Error(result.error || 'Could not convert quote to an order.');
      await drizzleDb
        .update(salesQuotes)
        .set({ status: 'converted', convertedOrderId: result.order.id, updatedAt: new Date() })
        .where(eq(salesQuotes.id, id));
      await this.event(id, 'converted', userId, {
        orderId: result.order.id,
        orderNumber: result.order.orderNumber,
      });
      return result.order;
    } catch (error) {
      await drizzleDb
        .update(salesQuotes)
        .set({ status: 'accepted', updatedAt: new Date() })
        .where(and(eq(salesQuotes.id, id), eq(salesQuotes.status, 'converting')));
      throw error;
    }
  }

  async send(userId: string, id: string) {
    const quote = await this.get(id);
    if (!quote) throw new Error('Quote not found.');
    if (!quote.customerEmail) throw new Error('Add a customer email before sending this quote.');
    if (!['draft', 'approved'].includes(quote.status))
      throw new Error('Only draft or approved quotes can be sent.');
    if (quote.approvalStatus === 'pending')
      throw new Error('This quote needs approval before it can be sent.');
    if (quote.approvalStatus === 'rejected')
      throw new Error(
        'Approval for this quote was refused. Reopen it from My requests, change it, and send it for approval again.',
      );
    if (quote.approvalStatus === 'draft')
      throw new Error('Send this quote for approval again before it can be sent to the customer.');
    if (quote.validUntil && quote.validUntil < new Date())
      throw new Error('This quote has expired.');
    const [company, companySettings] = await Promise.all([
      getContainer().companySettings.getProfile(),
      getContainer().companySettings.ensureSeeded(),
    ]);
    const token = randomBytes(32).toString('hex');
    const baseUrl =
      companySettings.publicBaseUrl?.replace(/\/$/, '') ||
      process.env.APP_URL?.replace(/\/$/, '') ||
      process.env.NEXTAUTH_URL?.replace(/\/$/, '') ||
      '';
    const acceptUrl = baseUrl ? `${baseUrl}/quote/${token}` : '';
    const pdf = await this.renderPdf(quote, company);
    const html = `<div style="font-family:Arial,sans-serif;color:#111827"><h2>${escapeHtml(company.tradingName)}</h2><p>Your quotation <strong>${escapeHtml(quote.quoteNumber)}</strong> totals ${escapeHtml(quote.currency)} ${num(quote.totalAmount).toFixed(2)}.</p>${quote.validUntil ? `<p>Valid until ${quote.validUntil.toLocaleDateString()}.</p>` : ''}${quote.publicNotes ? `<p>${escapeHtml(quote.publicNotes)}</p>` : ''}${acceptUrl ? `<p><a href="${acceptUrl}">Review and respond to this quote</a></p>` : ''}<p>This proforma quotation is not a tax invoice and does not confirm receipt of funds.</p></div>`;
    const sent = await getContainer().email.send({
      to: quote.customerEmail,
      subject: `${company.tradingName} quotation ${quote.quoteNumber}`,
      html,
      text: `Your quotation ${quote.quoteNumber} totals ${quote.currency} ${num(quote.totalAmount).toFixed(2)}.${acceptUrl ? ` Review and respond: ${acceptUrl}` : ''}`,
      replyTo: company.email,
      fromOverride: `${company.tradingName} Sales <${company.email}>`,
      attachments: [
        { filename: `${quote.quoteNumber}.pdf`, content: pdf, contentType: 'application/pdf' },
      ],
    });
    await drizzleDb
      .update(salesQuotes)
      .set({
        status: 'sent',
        sentAt: new Date(),
        shareTokenHash: tokenHash(token),
        updatedAt: new Date(),
      })
      .where(eq(salesQuotes.id, id));
    await this.event(id, 'sent', userId, {
      recipient: quote.customerEmail,
      messageId: sent.messageId ?? null,
    });
    return this.get(id);
  }

  async generatePdf(id: string) {
    const quote = await this.get(id);
    if (!quote) throw new Error('Quote not found.');
    const company = await getContainer().companySettings.getProfile();
    const pdf = await this.renderPdf(quote, company);
    // A quote only has a proforma, which is never signed. It still goes through the signing
    // service so the log records that it was considered and why it was not signed. Not
    // awaited: the PDF must not wait on bookkeeping.
    void getContainer()
      .kraSigning.processQuoteProforma(quote.id)
      .catch((error: unknown) => console.error('[kra-signing] hook failed', error));
    return { filename: `${quote.quoteNumber}.pdf`, pdfBase64: pdf.toString('base64') };
  }

  private async renderPdf(quote: SalesQuote, company: CompanyProfile) {
    return getContainer().invoicePdf.generate({
      documentType: 'sales_quote',
      invoiceNumber: quote.quoteNumber,
      issuedAt: new Date().toISOString(),
      orderId: quote.id,
      orderNumber: quote.quoteNumber,
      currency: quote.currency,
      company,
      customer: {
        name: quote.customerName,
        email: quote.customerEmail ?? '',
        phone: quote.customerPhone ?? '',
        kraPin: null,
        shippingAddress: {
          street: quote.billingAddress.street ?? '',
          city: quote.billingAddress.city ?? '',
          countyOrState: quote.billingAddress.countyOrState ?? '',
          postalCode: quote.billingAddress.postalCode,
          country: quote.billingAddress.country ?? '',
        },
      },
      items: [
        ...quote.lines
          .filter((line) => !line.sectionId)
          .map((line) => ({
            kind: 'item' as const,
            sku: line.sku,
            name: line.description,
            quantity: num(line.quantity),
            unitPrice: num(line.unitPrice),
            totalPrice: num(line.lineAmount),
          })),
        ...quote.sections.map((section) => {
          const lines = quote.lines.filter((line) => line.sectionId === section.id);
          const total = lines.reduce((sum, line) => sum + num(line.lineAmount), 0);
          return {
            kind: 'section' as const,
            sectionTotal: total,
            sectionDescription: section.description,
            sku: '',
            name: section.title,
            quantity: 0,
            unitPrice: 0,
            totalPrice: total,
          };
        }),
      ],
      subtotal: num(quote.subtotal),
      tax: num(quote.taxAmount),
      taxLabel: 'Tax',
      shippingFee: num(quote.shippingFee),
      totalAmount: num(quote.totalAmount),
      paymentMethod: quote.paymentMethod,
      paymentReference: null,
      paymentStatus: 'unpaid',
      customerReference: quote.customerReference,
      notes: quote.publicNotes,
      showBillingAddress: quote.showBillingAddress,
      billingInformation: quote.showBillingAddress
        ? {
            name: quote.customerName,
            email: quote.customerEmail,
            phone: quote.customerPhone,
            address: [
              quote.billingAddress.street,
              quote.billingAddress.city,
              quote.billingAddress.countyOrState,
              quote.billingAddress.postalCode,
              quote.billingAddress.country,
            ]
              .filter(Boolean)
              .join(', '),
          }
        : null,
      paymentDetails: quote.paymentDetails,
      paymentTerms: quote.paymentTerms,
      termsAndConditions: quote.termsAndConditions,
      validUntil: quote.validUntil?.toLocaleDateString(),
    });
  }

  async getShared(token: string) {
    if (!/^[a-f0-9]{64}$/i.test(token)) return null;
    const [quote] = await drizzleDb
      .select()
      .from(salesQuotes)
      .where(and(eq(salesQuotes.shareTokenHash, tokenHash(token)), eq(salesQuotes.status, 'sent')))
      .limit(1);
    if (!quote) return null;
    if (quote.validUntil && quote.validUntil < new Date()) {
      await drizzleDb
        .update(salesQuotes)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(and(eq(salesQuotes.id, quote.id), eq(salesQuotes.status, 'sent')));
      await this.event(quote.id, 'expired', null, { reason: 'valid_until_elapsed' });
      return null;
    }
    const rawLines = await drizzleDb
      .select({
        sectionId: salesQuoteLines.sectionId,
        sku: salesQuoteLines.sku,
        description: salesQuoteLines.description,
        quantity: salesQuoteLines.quantity,
        unitPrice: salesQuoteLines.unitPrice,
        discountPercent: salesQuoteLines.discountPercent,
        taxRate: salesQuoteLines.taxRate,
        isTaxInclusive: salesQuoteLines.isTaxInclusive,
        lineAmount: salesQuoteLines.lineAmount,
      })
      .from(salesQuoteLines)
      .where(eq(salesQuoteLines.quoteId, quote.id))
      .orderBy(salesQuoteLines.lineNumber);
    const rawSections = await drizzleDb
      .select({
        id: salesQuoteSections.id,
        title: salesQuoteSections.title,
        description: salesQuoteSections.description,
      })
      .from(salesQuoteSections)
      .where(eq(salesQuoteSections.quoteId, quote.id))
      .orderBy(salesQuoteSections.sectionNumber);
    const sections = rawSections;
    const lines = rawLines;
    const company = await getContainer().companySettings.getProfile();
    return {
      quoteNumber: quote.quoteNumber,
      status: quote.status,
      customerName: quote.customerName,
      showBillingAddress: quote.showBillingAddress,
      billingAddress: quote.billingAddress,
      currency: quote.currency,
      validUntil: quote.validUntil,
      customerReference: quote.customerReference,
      publicNotes: quote.publicNotes,
      paymentDetails: quote.paymentDetails,
      paymentTerms: quote.paymentTerms,
      termsAndConditions: quote.termsAndConditions,
      subtotal: quote.subtotal,
      taxAmount: quote.taxAmount,
      discountAmount: quote.discountAmount,
      shippingFee: quote.shippingFee,
      totalAmount: quote.totalAmount,
      lines,
      sections,
      company: {
        tradingName: company.tradingName,
        email: company.email,
        phone: company.phone,
        logoUrl: company.logoUrl,
      },
    };
  }

  async respondShared(token: string, accepted: boolean) {
    if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('This quote link is invalid.');
    const [quote] = await drizzleDb
      .select({ id: salesQuotes.id, validUntil: salesQuotes.validUntil })
      .from(salesQuotes)
      .where(and(eq(salesQuotes.shareTokenHash, tokenHash(token)), eq(salesQuotes.status, 'sent')))
      .limit(1);
    if (!quote)
      throw new Error('This quote link is no longer active. Contact the seller for assistance.');
    if (quote.validUntil && quote.validUntil < new Date()) {
      await drizzleDb
        .update(salesQuotes)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(eq(salesQuotes.id, quote.id));
      await this.event(quote.id, 'expired', null, { reason: 'customer_response_after_expiry' });
      throw new Error('This quote has expired. Contact the seller for an updated quote.');
    }
    const nextStatus = accepted ? 'accepted' : 'rejected';
    const [updated] = await drizzleDb
      .update(salesQuotes)
      .set({
        status: nextStatus,
        ...(accepted ? { acceptedAt: new Date() } : { rejectedAt: new Date() }),
        updatedAt: new Date(),
      })
      .where(and(eq(salesQuotes.id, quote.id), eq(salesQuotes.status, 'sent')))
      .returning({ id: salesQuotes.id });
    if (!updated) throw new Error('This quote has already received a response.');
    await this.event(quote.id, nextStatus, null, { source: 'customer_share_link' });
    if (accepted) {
      try {
        await this.convertToOrder('customer_acceptance', quote.id);
      } catch (error) {
        await this.event(quote.id, 'order_conversion_failed', null, {
          error: error instanceof Error ? error.message : 'Order conversion failed',
        });
      }
    }
    return nextStatus;
  }

  private async event(
    quoteId: string,
    eventType: string,
    actorId: string | null,
    details: Record<string, unknown>,
  ) {
    await drizzleDb.insert(salesQuoteEvents).values({ quoteId, eventType, actorId, details });
    await broadcastRealtime('quote_event', { quoteId, type: eventType });
  }

  private async templateEvent(
    templateId: string,
    eventType: string,
    actorId: string | null,
    details: Record<string, unknown>,
  ) {
    await drizzleDb
      .insert(salesQuoteTemplateEvents)
      .values({ templateId, eventType, actorId, details });
  }

  private assertPercent(value: number, label: string) {
    if (!Number.isFinite(value) || value < 0 || value > 100)
      throw new Error(`${label} must be between 0 and 100%.`);
  }
}
