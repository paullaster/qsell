import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { categoryDocuments, categoryQuestions, prequalAnswers, prequalEntries, prequalEvaluators, prequalScores, procurementCategories, reasonCodes, users, vendorDocumentTypes, vendorEvents, vendors, type PrequalStatus } from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import { passes, scoreTotals, validUntil } from '@/lib/prequalification';
import type { ReasonCodes } from '@/server/kernel/reason-codes/service';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import type { VendorNotifier } from './notifier';
import { heldDocumentTypes } from './prequal-service';

export const PREQUAL_DECISION = 'prequalification_decision';

const REASONS = [
  { code: 'PQ_BELOW_PASS_MARK', description: 'The score is below the pass mark', requiresComment: false },
  { code: 'PQ_MISSING_EVIDENCE', description: 'The evidence provided is not enough', requiresComment: true },
  { code: 'PQ_NOT_RELEVANT', description: 'The business does not offer what this category covers', requiresComment: false },
  { code: 'PQ_FAILED_CHECKS', description: 'The business failed our verification or reference checks', requiresComment: true },
  { code: 'PQ_PERFORMANCE', description: 'Poor performance on earlier work', requiresComment: true },
  { code: 'PQ_OTHER', description: 'Another reason (explain)', requiresComment: true },
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface ScoreEntry {
  questionId: string;
  score: number;
  comment: string;
}

export interface Conditions {
  maxOrderValue: string;
  note: string;
}

export interface EntryFilter {
  status?: string;
  categoryId?: string;
  before?: { createdAt: string; id: string } | null;
  limit?: number;
}

/**
 * What staff do with an application (design doc §7.3): take it to evaluate, score each question, and decide — approve (with a
 * validity and any conditions), refuse with a reason, or ask for changes. Where the category asks for four eyes, nobody who took
 * part in the evaluation decides it. Standing decisions (suspend, reinstate, revoke) are here too.
 */
export class PrequalReviewService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly reasons: ReasonCodes,
    private readonly notify?: VendorNotifier,
  ) {}

  async ensureReasons(companyId: string): Promise<void> {
    await this.db
      .insert(reasonCodes)
      .values(REASONS.map((r) => ({ companyId, code: r.code, description: r.description, requiresComment: r.requiresComment, appliesTo: [PREQUAL_DECISION], isSystem: true })))
      .onConflictDoNothing({ target: [reasonCodes.companyId, reasonCodes.code] });
  }

  private async event(tx: Tx | DrizzleDb, ctx: FinanceContext, vendorId: string, event: string, from: string | null, to: string | null, extra: { reasonCode?: string | null; reasonText?: string | null; data?: Record<string, unknown> } = {}): Promise<void> {
    await tx.insert(vendorEvents).values({ vendorId, event, fromStatus: from, toStatus: to, reasonCode: extra.reasonCode ?? null, reasonText: extra.reasonText ?? null, data: extra.data ?? {}, actorType: ctx.actor.type, actorId: ctx.actor.id, origin: { ...ctx.origin } });
  }

  private async lock(tx: Tx, ctx: FinanceContext, entryId: string) {
    const [row] = await tx
      .select({ e: prequalEntries, c: procurementCategories })
      .from(prequalEntries)
      .innerJoin(procurementCategories, eq(procurementCategories.id, prequalEntries.categoryId))
      .where(and(eq(prequalEntries.id, entryId), eq(prequalEntries.companyId, ctx.companyId)))
      .for('update', { of: prequalEntries });
    if (row === undefined) throw new FinanceError('NOT_FOUND', 'That application does not exist.');
    return row;
  }

  /** Applications, newest first, for the staff queue: submitted and being evaluated by default. */
  async list(companyId: string, f: EntryFilter = {}) {
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 100);
    const conds = [eq(prequalEntries.companyId, companyId), f.status !== undefined && f.status !== '' ? eq(prequalEntries.status, f.status as PrequalStatus) : inArray(prequalEntries.status, ['submitted', 'in_review'])];
    if (has(f.categoryId)) conds.push(eq(prequalEntries.categoryId, f.categoryId));
    if (f.before) conds.push(sql`(${prequalEntries.createdAt}::text, ${prequalEntries.id}::text) < (${f.before.createdAt}, ${f.before.id})`);
    const found = await this.db
      .select({ id: prequalEntries.id, status: prequalEntries.status, vendorId: vendors.id, vendorName: vendors.legalName, categoryName: procurementCategories.name, submittedAt: prequalEntries.submittedAt, validUntil: prequalEntries.validUntil, stamp: sql<string>`${prequalEntries.createdAt}::text` })
      .from(prequalEntries)
      .innerJoin(vendors, eq(vendors.id, prequalEntries.vendorId))
      .innerJoin(procurementCategories, eq(procurementCategories.id, prequalEntries.categoryId))
      .where(and(...conds))
      .orderBy(sql`${prequalEntries.createdAt} DESC`, sql`${prequalEntries.id} DESC`)
      .limit(limit + 1);
    const page = found.slice(0, limit);
    const last = page.at(-1);
    return { rows: page.map(({ stamp: _s, ...r }) => r), next: found.length > limit && last !== undefined ? { createdAt: last.stamp, id: last.id } : null };
  }

  /** Everything an evaluator needs: the answers, the documents and their checks, and everyone's scores. */
  async detail(companyId: string, entryId: string) {
    const [head] = await this.db
      .select({ e: prequalEntries, c: procurementCategories, vendorName: vendors.legalName, vendorNumber: vendors.number })
      .from(prequalEntries)
      .innerJoin(procurementCategories, eq(procurementCategories.id, prequalEntries.categoryId))
      .innerJoin(vendors, eq(vendors.id, prequalEntries.vendorId))
      .where(and(eq(prequalEntries.id, entryId), eq(prequalEntries.companyId, companyId)));
    if (head === undefined) return null;
    const [questions, answers, scores, evaluators, docTypes, held] = await Promise.all([
      this.db.select().from(categoryQuestions).where(eq(categoryQuestions.categoryId, head.c.id)).orderBy(asc(categoryQuestions.position)),
      this.db.select().from(prequalAnswers).where(eq(prequalAnswers.entryId, entryId)),
      this.db.select().from(prequalScores).where(eq(prequalScores.entryId, entryId)),
      this.db.select().from(prequalEvaluators).where(eq(prequalEvaluators.entryId, entryId)),
      this.db.select({ id: vendorDocumentTypes.id, name: vendorDocumentTypes.name }).from(categoryDocuments).innerJoin(vendorDocumentTypes, eq(vendorDocumentTypes.id, categoryDocuments.documentTypeId)).where(eq(categoryDocuments.categoryId, head.c.id)),
      heldDocumentTypes(this.db, head.e.vendorId),
    ]);
    const ids = [...new Set([...evaluators.map((e) => e.userId), ...scores.map((s) => s.evaluatorId)])].filter((i) => UUID.test(i));
    const names = ids.length === 0 ? [] : await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
    const nameOf = (id: string) => names.find((n) => n.id === id)?.name ?? id;
    const weights = Object.fromEntries(questions.map((q) => [q.id, q.weight]));
    const totals = scoreTotals(weights, scores.map((s) => ({ questionId: s.questionId, evaluatorId: s.evaluatorId, score: s.score })));
    return {
      entry: head.e,
      category: head.c,
      vendorName: head.vendorName,
      vendorNumber: head.vendorNumber,
      questions: questions.map((q) => ({ ...q, answer: answers.find((a) => a.questionId === q.id)?.value ?? '', scores: scores.filter((s) => s.questionId === q.id).map((s) => ({ evaluatorId: s.evaluatorId, evaluator: nameOf(s.evaluatorId), score: s.score, comment: s.comment })) })),
      documents: docTypes.map((d) => ({ id: d.id, name: d.name, held: held.get(d.id) ?? null })),
      evaluators: evaluators.map((e) => ({ userId: e.userId, name: nameOf(e.userId) })),
      totals: { ...totals, passMarkPercent: head.c.passMarkPercent === null ? null : Number(head.c.passMarkPercent), passed: passes(totals.total, totals.max, head.c.passMarkPercent === null ? null : Number(head.c.passMarkPercent)) },
    };
  }

  /** The caller takes the application to evaluate; several people may. */
  async take(ctx: FinanceContext, entryId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { e } = await this.lock(tx, ctx, entryId);
      if (e.status !== 'submitted' && e.status !== 'in_review') throw new FinanceError('NOT_SUBMITTED', 'This application is not waiting for evaluation.');
      await tx.insert(prequalEvaluators).values({ entryId, userId: ctx.actor.id ?? '' }).onConflictDoNothing();
      if (e.status === 'submitted') {
        await tx.update(prequalEntries).set({ status: 'in_review', updatedAt: new Date() }).where(eq(prequalEntries.id, entryId));
        await this.event(tx, ctx, e.vendorId, 'prequalification_review_started', 'submitted', 'in_review', { data: { entryId } });
      }
    });
  }

  /** The caller's own scores. A score cannot exceed what the question is worth. */
  async saveScores(ctx: FinanceContext, entryId: string, scores: ScoreEntry[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { e, c } = await this.lock(tx, ctx, entryId);
      if (e.status !== 'in_review') throw new FinanceError('NOT_IN_REVIEW', 'Take the application for evaluation before scoring it.');
      const [me] = await tx.select().from(prequalEvaluators).where(and(eq(prequalEvaluators.entryId, entryId), eq(prequalEvaluators.userId, ctx.actor.id ?? '')));
      if (me === undefined) throw new FinanceError('NOT_EVALUATOR', 'You are not one of the evaluators of this application.');
      const questions = await tx.select().from(categoryQuestions).where(eq(categoryQuestions.categoryId, c.id));
      for (const s of scores) {
        const q = questions.find((x) => x.id === s.questionId);
        if (q === undefined) throw new FinanceError('NOT_FOUND', 'That question is not part of this category.');
        if (!Number.isInteger(s.score) || s.score < 0 || s.score > q.weight) throw new FinanceError('INVALID', `A score for “${q.prompt}” is a whole number from 0 to ${String(q.weight)}.`);
        await tx
          .insert(prequalScores)
          .values({ entryId, evaluatorId: ctx.actor.id ?? '', questionId: q.id, score: s.score, comment: trimToNull(s.comment)?.slice(0, 500) ?? null })
          .onConflictDoUpdate({ target: [prequalScores.entryId, prequalScores.evaluatorId, prequalScores.questionId], set: { score: s.score, comment: trimToNull(s.comment)?.slice(0, 500) ?? null, updatedAt: new Date() } });
      }
    });
  }

  private async assertMayDecide(tx: Tx, ctx: FinanceContext, entryId: string, e: { status: PrequalStatus }, c: { fourEyes: boolean }): Promise<void> {
    if (e.status !== 'submitted' && e.status !== 'in_review') throw new FinanceError('NOT_SUBMITTED', 'This application is not waiting for a decision.');
    if (c.fourEyes) {
      const [mine] = await tx.select().from(prequalEvaluators).where(and(eq(prequalEvaluators.entryId, entryId), eq(prequalEvaluators.userId, ctx.actor.id ?? '')));
      if (mine !== undefined) throw new FinanceError('FOUR_EYES', 'Someone who did not evaluate this application must decide it.');
    }
  }

  async approve(ctx: FinanceContext, entryId: string, conditions: Conditions, today: string): Promise<{ validUntil: string }> {
    const maxOrder = trimToNull(conditions.maxOrderValue);
    if (maxOrder !== null && !(Number.isFinite(Number(maxOrder)) && Number(maxOrder) > 0 && /^\d{1,12}(\.\d{1,2})?$/.test(maxOrder))) throw new FinanceError('INVALID', 'The largest order value is an amount above zero, like 2000000.');
    const done = await this.db.transaction(async (tx) => {
      const { e, c } = await this.lock(tx, ctx, entryId);
      await this.assertMayDecide(tx, ctx, entryId, e, c);
      const [questions, scores, docs, held] = await Promise.all([
        tx.select().from(categoryQuestions).where(eq(categoryQuestions.categoryId, c.id)),
        tx.select().from(prequalScores).where(eq(prequalScores.entryId, entryId)),
        tx.select({ id: vendorDocumentTypes.id, name: vendorDocumentTypes.name }).from(categoryDocuments).innerJoin(vendorDocumentTypes, eq(vendorDocumentTypes.id, categoryDocuments.documentTypeId)).where(eq(categoryDocuments.categoryId, c.id)),
        heldDocumentTypes(tx as unknown as DrizzleDb, e.vendorId),
      ]);
      for (const d of docs) if (held.get(d.id) !== 'valid') throw new FinanceError('DOCUMENT_NOT_VERIFIED', `Check the vendor’s ${d.name.toLowerCase()} first (vendor profile → documents), then approve.`);
      const totals = scoreTotals(Object.fromEntries(questions.map((q) => [q.id, q.weight])), scores.map((s) => ({ questionId: s.questionId, evaluatorId: s.evaluatorId, score: s.score })));
      const mark = c.passMarkPercent === null ? null : Number(c.passMarkPercent);
      if (mark !== null && totals.max > 0 && scores.length === 0) throw new FinanceError('NOT_SCORED', 'Score the application first: this category has a pass mark.');
      if (passes(totals.total, totals.max, mark) === false) throw new FinanceError('BELOW_PASS_MARK', `The score is below the pass mark of ${String(mark)}%. Refuse the application, or ask for changes.`);
      const until = validUntil(today, c.validityMonths);
      await tx.update(prequalEntries).set({ status: 'approved', decidedAt: new Date(), decidedBy: ctx.actor.id, validFrom: today, validUntil: until, maxOrderValue: maxOrder, conditionsNote: trimToNull(conditions.note)?.slice(0, 500) ?? null, totalScore: String(totals.total), maxScore: String(totals.max), updatedAt: new Date() }).where(eq(prequalEntries.id, entryId));
      await this.event(tx, ctx, e.vendorId, 'prequalification_approved', e.status, 'approved', { data: { entryId, category: c.name, validUntil: until, maxOrderValue: maxOrder } });
      return { until, vendorId: e.vendorId, name: c.name };
    });
    await this.notify?.prequalDecided(done.vendorId, done.name, 'approved', trimToNull(conditions.note), done.until);
    return { validUntil: done.until };
  }

  async reject(ctx: FinanceContext, entryId: string, reason: { code: string; text?: string | null }): Promise<void> {
    await this.ensureReasons(ctx.companyId);
    const checked = await this.reasons.require(ctx.companyId, reason, PREQUAL_DECISION);
    const done = await this.db.transaction(async (tx) => {
      const { e, c } = await this.lock(tx, ctx, entryId);
      await this.assertMayDecide(tx, ctx, entryId, e, c);
      await tx.update(prequalEntries).set({ status: 'rejected', decidedAt: new Date(), decidedBy: ctx.actor.id, reasonCode: checked.code, decisionComment: checked.text, updatedAt: new Date() }).where(eq(prequalEntries.id, entryId));
      await this.event(tx, ctx, e.vendorId, 'prequalification_rejected', e.status, 'rejected', { reasonCode: checked.code, reasonText: checked.text, data: { entryId, category: c.name } });
      return { vendorId: e.vendorId, name: c.name };
    });
    await this.notify?.prequalDecided(done.vendorId, done.name, 'rejected', checked.text ?? REASONS.find((r) => r.code === checked.code)?.description ?? null, null);
  }

  async requestRevision(ctx: FinanceContext, entryId: string, note: string, dueDate: string): Promise<void> {
    const text = trimToNull(note);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say what the vendor must change.');
    const due = trimToNull(dueDate);
    if (due !== null && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new FinanceError('INVALID', 'Use a due date like 2026-12-31, or leave it empty.');
    const done = await this.db.transaction(async (tx) => {
      const { e, c } = await this.lock(tx, ctx, entryId);
      await this.assertMayDecide(tx, ctx, entryId, e, c);
      await tx.update(prequalEntries).set({ status: 'revision_requested', decidedAt: new Date(), decidedBy: ctx.actor.id, decisionComment: text.slice(0, 1000), revisionDue: due, updatedAt: new Date() }).where(eq(prequalEntries.id, entryId));
      await this.event(tx, ctx, e.vendorId, 'prequalification_revision_requested', e.status, 'revision_requested', { reasonText: text.slice(0, 1000), data: { entryId, category: c.name, due } });
      return { vendorId: e.vendorId, name: c.name };
    });
    await this.notify?.prequalDecided(done.vendorId, done.name, 'revision', text.slice(0, 1000), null);
  }

  private async standing(ctx: FinanceContext, entryId: string, from: PrequalStatus[], to: PrequalStatus, event: string, outcome: 'suspended' | 'revoked' | 'reinstated', reason: { code: string; text?: string | null } | null): Promise<void> {
    const checked = reason === null ? null : await (async () => {
      await this.ensureReasons(ctx.companyId);
      return await this.reasons.require(ctx.companyId, reason, PREQUAL_DECISION);
    })();
    const done = await this.db.transaction(async (tx) => {
      const { e, c } = await this.lock(tx, ctx, entryId);
      if (!from.includes(e.status)) throw new FinanceError('NOT_ALLOWED', `A qualification that is ${e.status.replace(/_/g, ' ')} cannot be ${outcome}.`);
      await tx.update(prequalEntries).set({ status: to, suspendedBecause: to === 'suspended' ? (checked?.text ?? checked?.code ?? 'staff') : null, updatedAt: new Date() }).where(eq(prequalEntries.id, entryId));
      await this.event(tx, ctx, e.vendorId, event, e.status, to, { reasonCode: checked?.code ?? null, reasonText: checked?.text ?? null, data: { entryId, category: c.name } });
      return { vendorId: e.vendorId, name: c.name, until: e.validUntil };
    });
    await this.notify?.prequalDecided(done.vendorId, done.name, outcome, checked?.text ?? null, outcome === 'reinstated' ? done.until : null);
  }

  suspend(ctx: FinanceContext, entryId: string, reason: { code: string; text?: string | null }) {
    return this.standing(ctx, entryId, ['approved'], 'suspended', 'prequalification_suspended', 'suspended', reason);
  }

  reinstate(ctx: FinanceContext, entryId: string) {
    return this.standing(ctx, entryId, ['suspended'], 'approved', 'prequalification_reinstated', 'reinstated', null);
  }

  revoke(ctx: FinanceContext, entryId: string, reason: { code: string; text?: string | null }) {
    return this.standing(ctx, entryId, ['approved', 'suspended'], 'revoked', 'prequalification_revoked', 'revoked', reason);
  }
}
