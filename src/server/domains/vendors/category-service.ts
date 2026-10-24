import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { categoryDocuments, categoryQuestions, prequalEntries, procurementCategories, vendorDocumentTypes, type CategoryStatus } from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import { checkCategory, checkQuestion, choiceList, type CategoryForm, type QuestionForm } from '@/lib/prequalification';
import { FinanceError } from '@/server/domains/finance/errors';
import { isUniqueViolation } from '@/server/domains/settings/errors';

const num = (v: string): string | null => (has(v) ? v.trim() : null);
const MAX_QUESTIONS = 40;

/**
 * The categories vendors can be qualified for, with their questions and required documents (design doc §7.1). Questions and
 * documents can change only while a category is a draft (the database refuses it otherwise): vendors apply under those terms.
 */
export class CategoryService {
  constructor(private readonly db: DrizzleDb) {}

  async list(companyId: string) {
    const rows = await this.db
      .select({ c: procurementCategories, live: sql<number>`(SELECT count(*)::int FROM prequal_entries e WHERE e.category_id = ${procurementCategories.id} AND e.status = 'approved')` })
      .from(procurementCategories)
      .where(eq(procurementCategories.companyId, companyId))
      .orderBy(asc(procurementCategories.name));
    return rows.map((r) => ({ ...r.c, qualified: r.live }));
  }

  async get(companyId: string, id: string) {
    const [c] = await this.db.select().from(procurementCategories).where(and(eq(procurementCategories.companyId, companyId), eq(procurementCategories.id, id)));
    if (c === undefined) return null;
    const [questions, docs] = await Promise.all([
      this.db.select().from(categoryQuestions).where(eq(categoryQuestions.categoryId, id)).orderBy(asc(categoryQuestions.position), asc(categoryQuestions.id)),
      this.db.select({ documentTypeId: categoryDocuments.documentTypeId, name: vendorDocumentTypes.name }).from(categoryDocuments).innerJoin(vendorDocumentTypes, eq(vendorDocumentTypes.id, categoryDocuments.documentTypeId)).where(eq(categoryDocuments.categoryId, id)),
    ]);
    return { category: c, questions, documents: docs };
  }

  private async ensureParent(companyId: string, id: string | null, parentId: string): Promise<string | null> {
    if (!has(parentId)) return null;
    if (parentId === id) throw new FinanceError('INVALID', 'A category cannot be inside itself.');
    const [parent] = await this.db.select({ id: procurementCategories.id }).from(procurementCategories).where(and(eq(procurementCategories.companyId, companyId), eq(procurementCategories.id, parentId)));
    if (parent === undefined) throw new FinanceError('NOT_FOUND', 'The parent category does not exist.');
    if (id !== null) {
      // Walking up from the parent must never reach this category, or the tree would loop.
      const up = await this.db.execute<{ id: string }>(sql`
        WITH RECURSIVE up AS (SELECT id, parent_id FROM procurement_categories WHERE id = ${parentId}::uuid
          UNION SELECT c.id, c.parent_id FROM procurement_categories c JOIN up ON c.id = up.parent_id)
        SELECT id FROM up WHERE id = ${id}::uuid`);
      if ([...up].length > 0) throw new FinanceError('INVALID', 'A category cannot be placed inside one of its own sub-categories.');
    }
    return parentId;
  }

  async save(companyId: string, id: string | null, f: CategoryForm): Promise<{ id: string }> {
    const problems = checkCategory(f, id === null);
    const first = Object.values(problems)[0];
    if (has(first)) throw new FinanceError('INVALID', first);
    const parentId = await this.ensureParent(companyId, id, f.parentId);
    const values = {
      name: f.name.trim(),
      description: trimToNull(f.description),
      parentId,
      validityMonths: Number(f.validityMonths),
      windowFrom: num(f.windowFrom),
      windowTo: num(f.windowTo),
      passMarkPercent: num(f.passMarkPercent),
      fourEyes: f.fourEyes,
      showTotalScore: f.showTotalScore,
      showPassMark: f.showPassMark,
      showQuestionScores: f.showQuestionScores,
      showEvaluatorComments: f.showEvaluatorComments,
      updatedAt: new Date(),
    };
    try {
      if (id === null) {
        const [made] = await this.db.insert(procurementCategories).values({ companyId, code: f.code.trim().toUpperCase(), ...values }).returning({ id: procurementCategories.id });
        if (made === undefined) throw new FinanceError('NOT_SAVED', 'The category could not be saved.');
        return made;
      }
      const [row] = await this.db.select({ status: procurementCategories.status }).from(procurementCategories).where(and(eq(procurementCategories.companyId, companyId), eq(procurementCategories.id, id)));
      if (row === undefined) throw new FinanceError('NOT_FOUND', 'That category does not exist.');
      // What a vendor applied under is fixed: the pass mark and validity move only while nobody can have applied.
      const terms = row.status === 'draft' ? {} : { validityMonths: undefined, passMarkPercent: undefined, fourEyes: undefined };
      await this.db.update(procurementCategories).set({ ...values, ...terms }).where(eq(procurementCategories.id, id));
      return { id };
    } catch (error) {
      if (isUniqueViolation(error)) throw new FinanceError('DUPLICATE', 'A category with this code already exists.');
      throw error;
    }
  }

  private async draft(companyId: string, categoryId: string): Promise<void> {
    const [c] = await this.db.select({ status: procurementCategories.status }).from(procurementCategories).where(and(eq(procurementCategories.companyId, companyId), eq(procurementCategories.id, categoryId)));
    if (c === undefined) throw new FinanceError('NOT_FOUND', 'That category does not exist.');
    if (c.status !== 'draft') throw new FinanceError('LOCKED', 'Vendors can apply under these questions, so they are fixed. Close this category and make a new one to change them.');
  }

  async addQuestion(companyId: string, categoryId: string, q: QuestionForm): Promise<{ id: string }> {
    const problems = checkQuestion(q);
    const first = Object.values(problems)[0];
    if (has(first)) throw new FinanceError('INVALID', first);
    await this.draft(companyId, categoryId);
    const [n] = await this.db.select({ n: sql<number>`count(*)::int`, top: sql<number>`COALESCE(max(position), -1)::int` }).from(categoryQuestions).where(eq(categoryQuestions.categoryId, categoryId));
    if ((n?.n ?? 0) >= MAX_QUESTIONS) throw new FinanceError('TOO_MANY', `A category can have at most ${String(MAX_QUESTIONS)} questions.`);
    const [made] = await this.db.insert(categoryQuestions).values({ categoryId, position: (n?.top ?? -1) + 1, prompt: q.prompt.trim(), kind: q.kind, choices: q.kind === 'choice' ? choiceList(q.choices) : [], weight: Number(q.weight), required: q.required }).returning({ id: categoryQuestions.id });
    if (made === undefined) throw new FinanceError('NOT_SAVED', 'The question could not be saved.');
    return made;
  }

  async removeQuestion(companyId: string, categoryId: string, questionId: string): Promise<void> {
    await this.draft(companyId, categoryId);
    await this.db.delete(categoryQuestions).where(and(eq(categoryQuestions.categoryId, categoryId), eq(categoryQuestions.id, questionId)));
  }

  async setDocuments(companyId: string, categoryId: string, documentTypeIds: string[]): Promise<void> {
    await this.draft(companyId, categoryId);
    const ids = [...new Set(documentTypeIds)];
    if (ids.length > 0) {
      const found = await this.db.select({ id: vendorDocumentTypes.id }).from(vendorDocumentTypes).where(and(eq(vendorDocumentTypes.companyId, companyId), inArray(vendorDocumentTypes.id, ids)));
      if (found.length !== ids.length) throw new FinanceError('NOT_FOUND', 'One of those document types does not exist.');
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(categoryDocuments).where(eq(categoryDocuments.categoryId, categoryId));
      if (ids.length > 0) await tx.insert(categoryDocuments).values(ids.map((documentTypeId) => ({ categoryId, documentTypeId })));
    });
  }

  /** draft → open → closed → open again, and archived from closed or draft. */
  async setStatus(companyId: string, categoryId: string, to: CategoryStatus): Promise<void> {
    const allowed: Record<CategoryStatus, CategoryStatus[]> = { draft: ['open', 'archived'], open: ['closed'], closed: ['open', 'archived'], archived: [] };
    await this.db.transaction(async (tx) => {
      const [c] = await tx.select({ status: procurementCategories.status }).from(procurementCategories).where(and(eq(procurementCategories.companyId, companyId), eq(procurementCategories.id, categoryId))).for('update');
      if (c === undefined) throw new FinanceError('NOT_FOUND', 'That category does not exist.');
      if (!allowed[c.status].includes(to)) throw new FinanceError('NOT_ALLOWED', `A ${c.status} category cannot become ${to}.`);
      if (to === 'archived') {
        const [live] = await tx.select({ id: prequalEntries.id }).from(prequalEntries).where(and(eq(prequalEntries.categoryId, categoryId), inArray(prequalEntries.status, ['submitted', 'in_review', 'revision_requested', 'approved', 'suspended']))).limit(1);
        if (live !== undefined) throw new FinanceError('IN_USE', 'Vendors are still applying or qualified in this category. Close it and let those finish first.');
      }
      await tx.update(procurementCategories).set({ status: to, updatedAt: new Date() }).where(eq(procurementCategories.id, categoryId));
    });
  }
}
