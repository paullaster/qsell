import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { getContainer } from '@/server/di/container';
import { drizzleDb } from '@/server/db/drizzle/client';
import {
  salesSectionTemplateEvents,
  salesSectionTemplateLines,
  salesSectionTemplates,
  type SalesSectionTemplateEventRow,
  type SalesSectionTemplateLineRow,
  type SalesSectionTemplateRow,
} from '@/server/db/drizzle/schema';
import { CatalogService } from '@/server/domains/catalog/service';

export interface SectionTemplateInput {
  name: string;
  category?: string | null;
  description?: string | null;
  /** The title, description and print choice of the section a quote gets from this template. */
  sectionTitle: string;
  sectionDescription?: string | null;
  showLines: boolean;
  lines: {
    productId: string;
    quantity: number;
    priceMode: 'catalog' | 'fixed';
    unitPrice?: number | null;
    discountPercent: number;
  }[];
}

export interface SectionTemplate extends SalesSectionTemplateRow {
  lines: SalesSectionTemplateLineRow[];
  events: SalesSectionTemplateEventRow[];
}

/**
 * Reusable sections. A quote copies one when it is added, so editing or archiving a template never
 * changes a quote that already used it.
 */
export class SectionTemplateService {
  private async companyId() {
    return (await getContainer().companySettings.ensureSeeded()).id;
  }

  /** Every template of the company with its items, in two queries however many there are. */
  async list(): Promise<SectionTemplate[]> {
    const companyId = await this.companyId();
    const rows = await drizzleDb
      .select()
      .from(salesSectionTemplates)
      .where(eq(salesSectionTemplates.companyId, companyId))
      .orderBy(desc(salesSectionTemplates.updatedAt));
    if (rows.length === 0) return [];
    const lines = await drizzleDb
      .select()
      .from(salesSectionTemplateLines)
      .where(
        inArray(
          salesSectionTemplateLines.templateId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(salesSectionTemplateLines.lineNumber));
    return rows.map((row) => ({
      ...row,
      lines: lines.filter((line) => line.templateId === row.id),
      events: [],
    }));
  }

  async get(id: string): Promise<SectionTemplate | null> {
    const companyId = await this.companyId();
    const [row] = await drizzleDb
      .select()
      .from(salesSectionTemplates)
      .where(and(eq(salesSectionTemplates.id, id), eq(salesSectionTemplates.companyId, companyId)));
    if (!row) return null;
    const [lines, events] = await Promise.all([
      drizzleDb
        .select()
        .from(salesSectionTemplateLines)
        .where(eq(salesSectionTemplateLines.templateId, id))
        .orderBy(asc(salesSectionTemplateLines.lineNumber)),
      drizzleDb
        .select()
        .from(salesSectionTemplateEvents)
        .where(eq(salesSectionTemplateEvents.templateId, id))
        .orderBy(desc(salesSectionTemplateEvents.createdAt)),
    ]);
    return { ...row, lines, events };
  }

  async save(userId: string, id: string | null, input: SectionTemplateInput) {
    const companyId = await this.companyId();
    const name = input.name.trim();
    if (!name) throw new Error('Section template name is required.');
    const sectionTitle = input.sectionTitle.trim();
    if (!sectionTitle) throw new Error('Give the section a title.');
    if (input.lines.length === 0) throw new Error('Add at least one product to the section.');
    const existing = id ? await this.get(id) : null;
    if (id && !existing) throw new Error('Section template not found.');
    if (existing?.status === 'archived')
      throw new Error('An archived section template is read-only.');
    const products = new Map(
      (await CatalogService.getProductsByIds(input.lines.map((line) => line.productId))).map(
        (p) => [p.id, p],
      ),
    );
    const lines = input.lines.map((line, index) => {
      const product = products.get(line.productId);
      if (!product || !product.isSellable)
        throw new Error('A section item is missing or is not sellable.');
      if (!Number.isFinite(line.quantity) || line.quantity <= 0)
        throw new Error(`${product.name} needs a quantity greater than zero.`);
      if (
        !Number.isFinite(line.discountPercent) ||
        line.discountPercent < 0 ||
        line.discountPercent > 100
      )
        throw new Error(`${product.name} discount must be between 0 and 100.`);
      const unitPrice = line.priceMode === 'fixed' ? line.unitPrice : null;
      if (line.priceMode === 'fixed' && (!Number.isFinite(unitPrice) || Number(unitPrice) < 0))
        throw new Error(`${product.name} needs a valid fixed selling price.`);
      return {
        productId: product.id,
        lineNumber: (index + 1) * 10000,
        sku: product.sku,
        description: product.name,
        quantity: line.quantity.toFixed(3),
        priceMode: line.priceMode,
        unitPrice: unitPrice == null ? null : Number(unitPrice).toFixed(4),
        discountPercent: line.discountPercent.toFixed(3),
      };
    });
    const values = {
      companyId,
      name,
      category: input.category?.trim() || null,
      description: input.description?.trim() || null,
      sectionTitle,
      sectionDescription: input.sectionDescription?.trim() || null,
      showLines: input.showLines === true,
      updatedBy: userId,
      updatedAt: new Date(),
    };
    try {
      const saved = await drizzleDb.transaction(async (tx) => {
        let template: SalesSectionTemplateRow;
        if (existing) {
          const [updated] = await tx
            .update(salesSectionTemplates)
            .set(values)
            .where(eq(salesSectionTemplates.id, existing.id))
            .returning();
          template = updated!;
          await tx
            .delete(salesSectionTemplateLines)
            .where(eq(salesSectionTemplateLines.templateId, template.id));
        } else {
          const [created] = await tx
            .insert(salesSectionTemplates)
            .values({ ...values, createdBy: userId })
            .returning();
          template = created!;
        }
        await tx
          .insert(salesSectionTemplateLines)
          .values(lines.map((line) => ({ ...line, templateId: template.id })));
        await tx.insert(salesSectionTemplateEvents).values({
          templateId: template.id,
          eventType: existing ? 'updated' : 'created',
          actorId: userId,
          details: { lineCount: lines.length },
        });
        return template;
      });
      return (await this.get(saved.id))!;
    } catch (error) {
      if (
        error instanceof Error &&
        /sales_section_templates_company_name_uidx/.test(String(error.cause ?? error.message))
      )
        throw new Error('A section template with that name already exists.');
      throw error;
    }
  }

  async duplicate(userId: string, id: string) {
    const original = await this.get(id);
    if (!original) throw new Error('Section template not found.');
    const names = new Set((await this.list()).map((t) => t.name.toLowerCase()));
    let name = `${original.name} (Copy)`;
    for (let copy = 2; names.has(name.toLowerCase()); copy += 1)
      name = `${original.name} (Copy ${copy})`;
    return this.save(userId, null, {
      name,
      category: original.category,
      description: original.description,
      sectionTitle: original.sectionTitle,
      sectionDescription: original.sectionDescription,
      showLines: original.showLines,
      lines: original.lines.map((line) => ({
        productId: line.productId ?? '',
        quantity: Number(line.quantity),
        priceMode: line.priceMode as 'catalog' | 'fixed',
        unitPrice: line.unitPrice == null ? null : Number(line.unitPrice),
        discountPercent: Number(line.discountPercent),
      })),
    });
  }

  async archive(userId: string, id: string) {
    const existing = await this.get(id);
    if (!existing) throw new Error('Section template not found.');
    await drizzleDb
      .update(salesSectionTemplates)
      .set({ status: 'archived', updatedBy: userId, updatedAt: new Date() })
      .where(eq(salesSectionTemplates.id, id));
    await drizzleDb.insert(salesSectionTemplateEvents).values({
      templateId: id,
      eventType: 'archived',
      actorId: userId,
      details: {},
    });
  }
}
