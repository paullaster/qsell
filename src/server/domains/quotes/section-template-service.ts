import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
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
import { encodeCursor, escapeLike } from '@/server/domains/lookups/request';
import { parseSectionTemplateInput, type SectionTemplateInput } from './section-template-input';
import type { TemplateListRequest } from './template-list';

export type { SectionTemplateInput };

/** A section template as the management list shows it. */
export interface SectionTemplateListRow {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  status: string;
  sectionTitle: string;
  usageCount: number;
  lineCount: number;
}

export interface SectionTemplateListPage {
  rows: SectionTemplateListRow[];
  nextCursor: string | null;
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

  /** One page of the section templates list: a summary of each, newest change first. */
  async listPage(request: TemplateListRequest): Promise<SectionTemplateListPage> {
    const companyId = await this.companyId();
    const pattern = `%${escapeLike(request.query)}%`;
    const conditions: (SQL | undefined)[] = [
      eq(salesSectionTemplates.companyId, companyId),
      request.status === 'all' ? undefined : eq(salesSectionTemplates.status, request.status),
      request.query === ''
        ? undefined
        : or(
            ilike(salesSectionTemplates.name, pattern),
            ilike(salesSectionTemplates.category, pattern),
            ilike(salesSectionTemplates.description, pattern),
            ilike(salesSectionTemplates.sectionTitle, pattern),
          ),
      request.after === null
        ? undefined
        : sql`(${salesSectionTemplates.updatedAt}, ${salesSectionTemplates.id}) < (${request.after.k}::timestamptz, ${request.after.id}::uuid)`,
    ];
    const rows = await drizzleDb
      .select({
        id: salesSectionTemplates.id,
        name: salesSectionTemplates.name,
        category: salesSectionTemplates.category,
        description: salesSectionTemplates.description,
        status: salesSectionTemplates.status,
        sectionTitle: salesSectionTemplates.sectionTitle,
        usageCount: salesSectionTemplates.usageCount,
        // Qualified by hand: in a one-table query the column would print without its table name
        // and the subquery would compare against its own `id`.
        lineCount: sql<number>`(select count(*)::int from ${salesSectionTemplateLines} where ${salesSectionTemplateLines.templateId} = ${sql.raw('"sales_section_templates"."id"')})`,
        changedAt: sql<string>`${salesSectionTemplates.updatedAt}::text`,
      })
      .from(salesSectionTemplates)
      .where(and(...conditions))
      .orderBy(desc(salesSectionTemplates.updatedAt), desc(salesSectionTemplates.id))
      .limit(request.limit + 1);
    const page = rows.slice(0, request.limit);
    const last = page.at(-1);
    return {
      rows: page.map(({ changedAt: _changedAt, ...row }) => row),
      nextCursor:
        rows.length > request.limit && last !== undefined
          ? encodeCursor({ k: last.changedAt, id: last.id })
          : null,
    };
  }

  async get(id: string): Promise<SectionTemplate | null> {
    const companyId = await this.companyId();
    const rows = await drizzleDb
      .select()
      .from(salesSectionTemplates)
      .where(and(eq(salesSectionTemplates.id, id), eq(salesSectionTemplates.companyId, companyId)));
    const row = rows.at(0);
    if (row === undefined) return null;
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

  async save(userId: string, id: string | null, raw: unknown): Promise<SectionTemplate> {
    const companyId = await this.companyId();
    const input = parseSectionTemplateInput(raw);
    const existing = id === null ? null : await this.get(id);
    if (id !== null && existing === null) throw new Error('Section template not found.');
    if (existing?.status === 'archived') {
      throw new Error('An archived section template is read-only.');
    }
    const products = new Map(
      (await CatalogService.getProductsByIds(input.lines.map((line) => line.productId))).map(
        (p) => [p.id, p],
      ),
    );
    const lines = input.lines.map((line, index) => {
      const product = products.get(line.productId);
      if (product?.isSellable !== true) {
        throw new Error(`Item ${String(index + 1)} is missing or is not sellable.`);
      }
      return {
        productId: product.id,
        lineNumber: (index + 1) * 10000,
        sku: product.sku,
        description: product.name,
        quantity: line.quantity.toFixed(3),
        priceMode: line.priceMode,
        unitPrice: line.unitPrice === null ? null : line.unitPrice.toFixed(4),
        discountPercent: line.discountPercent.toFixed(3),
      };
    });
    const values = {
      companyId,
      name: input.name,
      category: input.category,
      description: input.description,
      sectionTitle: input.sectionTitle,
      sectionDescription: input.sectionDescription,
      showLines: input.showLines,
      updatedBy: userId,
      updatedAt: new Date(),
    };
    try {
      const savedId = await drizzleDb.transaction(async (tx) => {
        let templateId: string;
        if (existing === null) {
          const created = await tx
            .insert(salesSectionTemplates)
            .values({ ...values, createdBy: userId })
            .returning({ id: salesSectionTemplates.id })
            .then((rows) => rows.at(0));
          if (created === undefined) throw new Error('Could not save the section template.');
          templateId = created.id;
        } else {
          const updated = await tx
            .update(salesSectionTemplates)
            .set(values)
            .where(eq(salesSectionTemplates.id, existing.id))
            .returning({ id: salesSectionTemplates.id });
          if (updated.length === 0) throw new Error('The section template changed. Try again.');
          templateId = existing.id;
          await tx
            .delete(salesSectionTemplateLines)
            .where(eq(salesSectionTemplateLines.templateId, templateId));
        }
        await tx
          .insert(salesSectionTemplateLines)
          .values(lines.map((line) => ({ ...line, templateId })));
        await tx.insert(salesSectionTemplateEvents).values({
          templateId,
          eventType: existing === null ? 'created' : 'updated',
          actorId: userId,
          details: { lineCount: lines.length },
        });
        return templateId;
      });
      const saved = await this.get(savedId);
      if (saved === null) throw new Error('Could not save the section template.');
      return saved;
    } catch (error: unknown) {
      const reason =
        error instanceof Error
          ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ''}`
          : '';
      if (reason.includes('sales_section_templates_company_name_uidx')) {
        throw new Error('A section template with that name already exists.', { cause: error });
      }
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
    return await this.save(userId, null, {
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
