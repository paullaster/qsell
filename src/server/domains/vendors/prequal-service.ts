import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { categoryDocuments, categoryQuestions, prequalAnswers, prequalEntries, prequalScores, procurementCategories, vendorDocumentTypes, vendorDocuments, vendorEvents, vendors } from '@/server/db/drizzle/schema';
import { acceptingApplications, answerProblems, LIVE_STATUSES } from '@/lib/prequalification';
import { has } from '@/lib/values';
import type { VendorNotifier } from './notifier';
import { ProfileError, type PortalActor } from './profile-service';

const EDITABLE = ['draft', 'revision_requested'] as const;
const WITHDRAWABLE = ['draft', 'submitted', 'in_review', 'revision_requested'] as const;
const MAX_AT_ONCE = 10;

/** The documents of these types the vendor holds right now (sent or checked, not replaced, expired or refused). */
export async function heldDocumentTypes(db: DrizzleDb, vendorId: string): Promise<Map<string, 'submitted' | 'valid'>> {
  const rows = await db.select({ typeId: vendorDocuments.documentTypeId, status: vendorDocuments.status }).from(vendorDocuments).where(and(eq(vendorDocuments.vendorId, vendorId), inArray(vendorDocuments.status, ['submitted', 'valid'])));
  const held = new Map<string, 'submitted' | 'valid'>();
  for (const r of rows) if (held.get(r.typeId) !== 'valid') held.set(r.typeId, r.status === 'valid' ? 'valid' : 'submitted');
  return held;
}

/**
 * A vendor's own prequalification (design doc §7.2): the categories it can apply for, the questionnaire and the documents each
 * asks for, the submission, and what it is told of the result. Every method takes the vendor from the session.
 */
export class PrequalService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly notify?: VendorNotifier,
  ) {}

  private async event(vendorId: string, event: string, actor: PortalActor, data: Record<string, unknown>): Promise<void> {
    await this.db.insert(vendorEvents).values({ vendorId, event, data, actorType: 'user', actorId: actor.userId, origin: { surface: 'vendor/portal', action: event } });
  }

  private mayApply(actor: PortalActor): void {
    if (actor.portalRole !== 'owner' && actor.portalRole !== 'sales') throw new ProfileError('NOT_ALLOWED', 'Only the owner or the sales person can apply for a category.');
  }

  /** Every category the vendor could apply for now, with where it already stands in each and what it is missing. */
  async open(companyId: string, vendorId: string, today: string) {
    const [vendor] = await this.db.select({ status: vendors.status }).from(vendors).where(eq(vendors.id, vendorId));
    const [cats, mine, docs, held] = await Promise.all([
      this.db.select().from(procurementCategories).where(and(eq(procurementCategories.companyId, companyId), eq(procurementCategories.status, 'open'))).orderBy(asc(procurementCategories.name)),
      this.db.select({ id: prequalEntries.id, categoryId: prequalEntries.categoryId, status: prequalEntries.status, validUntil: prequalEntries.validUntil }).from(prequalEntries).where(and(eq(prequalEntries.vendorId, vendorId), inArray(prequalEntries.status, [...LIVE_STATUSES]))),
      this.db.select({ categoryId: categoryDocuments.categoryId, name: vendorDocumentTypes.name, id: vendorDocumentTypes.id }).from(categoryDocuments).innerJoin(vendorDocumentTypes, eq(vendorDocumentTypes.id, categoryDocuments.documentTypeId)),
      heldDocumentTypes(this.db, vendorId),
    ]);
    const names = new Map(cats.map((c) => [c.id, c.name]));
    return {
      canApply: vendor?.status === 'active',
      categories: cats
        .filter((c) => acceptingApplications(c.status, c.windowFrom, c.windowTo, today) || mine.some((m) => m.categoryId === c.id))
        .map((c) => ({
          id: c.id,
          name: c.name,
          path: [...(c.parentId === null ? [] : [names.get(c.parentId) ?? ''])].filter((x) => x !== '').join(' › '),
          description: c.description,
          validityMonths: c.validityMonths,
          accepting: acceptingApplications(c.status, c.windowFrom, c.windowTo, today),
          mine: mine.find((m) => m.categoryId === c.id) ?? null,
          missingDocuments: docs.filter((d) => d.categoryId === c.id && !held.has(d.id)).map((d) => d.name),
        })),
    };
  }

  /** All the vendor's applications and qualifications, newest first. */
  async mine(vendorId: string) {
    return await this.db
      .select({ id: prequalEntries.id, status: prequalEntries.status, categoryName: procurementCategories.name, submittedAt: prequalEntries.submittedAt, validUntil: prequalEntries.validUntil, maxOrderValue: prequalEntries.maxOrderValue, conditionsNote: prequalEntries.conditionsNote })
      .from(prequalEntries)
      .innerJoin(procurementCategories, eq(procurementCategories.id, prequalEntries.categoryId))
      .where(eq(prequalEntries.vendorId, vendorId))
      .orderBy(desc(prequalEntries.createdAt))
      .limit(200);
  }

  /** Starts an application for each chosen category. The earlier answers for a category it held before are filled in. */
  async apply(actor: PortalActor, companyId: string, categoryIds: string[], today: string): Promise<{ ids: string[] }> {
    this.mayApply(actor);
    const wanted = [...new Set(categoryIds)];
    if (wanted.length === 0) throw new ProfileError('INVALID', 'Choose at least one category.');
    if (wanted.length > MAX_AT_ONCE) throw new ProfileError('TOO_MANY', `Apply for at most ${String(MAX_AT_ONCE)} categories at a time.`);
    const ids = await this.db.transaction(async (tx) => {
      const [v] = await tx.select({ status: vendors.status }).from(vendors).where(eq(vendors.id, actor.vendorId)).for('update');
      if (v?.status !== 'active') throw new ProfileError('NOT_ACTIVE', 'You can apply for categories once your business profile is approved.');
      const cats = await tx.select().from(procurementCategories).where(and(eq(procurementCategories.companyId, companyId), inArray(procurementCategories.id, wanted)));
      if (cats.length !== wanted.length) throw new ProfileError('NOT_FOUND', 'One of those categories does not exist.');
      const out: string[] = [];
      for (const c of cats) {
        if (!acceptingApplications(c.status, c.windowFrom, c.windowTo, today)) throw new ProfileError('CLOSED', `${c.name} is not taking applications now.`);
        const [live] = await tx.select({ id: prequalEntries.id }).from(prequalEntries).where(and(eq(prequalEntries.vendorId, actor.vendorId), eq(prequalEntries.categoryId, c.id), inArray(prequalEntries.status, [...LIVE_STATUSES])));
        if (live !== undefined) throw new ProfileError('ALREADY', `You already have an application or a qualification for ${c.name}.`);
        const [previous] = await tx.select({ id: prequalEntries.id }).from(prequalEntries).where(and(eq(prequalEntries.vendorId, actor.vendorId), eq(prequalEntries.categoryId, c.id))).orderBy(desc(prequalEntries.createdAt)).limit(1);
        const [made] = await tx.insert(prequalEntries).values({ companyId, vendorId: actor.vendorId, categoryId: c.id, previousEntryId: previous?.id ?? null }).returning({ id: prequalEntries.id });
        if (made === undefined) throw new ProfileError('NOT_SAVED', 'The application could not be started.');
        if (previous !== undefined) {
          await tx.execute(sql`INSERT INTO prequal_answers (entry_id, question_id, value)
            SELECT ${made.id}::uuid, a.question_id, a.value FROM prequal_answers a
            JOIN category_questions q ON q.id = a.question_id WHERE a.entry_id = ${previous.id}::uuid`);
        }
        out.push(made.id);
      }
      return out;
    });
    await this.event(actor.vendorId, 'prequalification_started', actor, { entries: ids });
    return { ids };
  }

  private async entryOf(actor: PortalActor, entryId: string) {
    const [row] = await this.db
      .select({ e: prequalEntries, c: procurementCategories })
      .from(prequalEntries)
      .innerJoin(procurementCategories, eq(procurementCategories.id, prequalEntries.categoryId))
      .where(and(eq(prequalEntries.id, entryId), eq(prequalEntries.vendorId, actor.vendorId)));
    if (row === undefined) throw new ProfileError('NOT_FOUND', 'That application does not exist.');
    return row;
  }

  /** The application with its questions, answers, documents, and the part of the result this category lets the vendor see. */
  async load(actor: PortalActor, entryId: string) {
    const { e, c } = await this.entryOf(actor, entryId);
    const [questions, answers, docs, held] = await Promise.all([
      this.db.select().from(categoryQuestions).where(eq(categoryQuestions.categoryId, c.id)).orderBy(asc(categoryQuestions.position)),
      this.db.select().from(prequalAnswers).where(eq(prequalAnswers.entryId, e.id)),
      this.db.select({ id: vendorDocumentTypes.id, name: vendorDocumentTypes.name }).from(categoryDocuments).innerJoin(vendorDocumentTypes, eq(vendorDocumentTypes.id, categoryDocuments.documentTypeId)).where(eq(categoryDocuments.categoryId, c.id)),
      heldDocumentTypes(this.db, actor.vendorId),
    ]);
    const decided = ['approved', 'rejected', 'suspended', 'revoked', 'expired', 'revision_requested'].includes(e.status);
    const scores = decided && c.showQuestionScores ? await this.db.select({ questionId: prequalScores.questionId, score: prequalScores.score, comment: prequalScores.comment }).from(prequalScores).where(eq(prequalScores.entryId, e.id)) : [];
    const perQuestion = new Map<string, { score: number; n: number; comments: string[] }>();
    for (const s of scores) {
      const cur = perQuestion.get(s.questionId) ?? { score: 0, n: 0, comments: [] };
      cur.score += s.score;
      cur.n += 1;
      if (c.showEvaluatorComments && has(s.comment)) cur.comments.push(s.comment);
      perQuestion.set(s.questionId, cur);
    }
    const comments = decided && c.showEvaluatorComments && !c.showQuestionScores
      ? (await this.db.select({ comment: prequalScores.comment }).from(prequalScores).where(eq(prequalScores.entryId, e.id))).map((r) => r.comment).filter((x): x is string => has(x))
      : [];
    return {
      id: e.id,
      status: e.status,
      categoryName: c.name,
      description: c.description,
      canEdit: (EDITABLE as readonly string[]).includes(e.status) && (actor.portalRole === 'owner' || actor.portalRole === 'sales'),
      questions: questions.map((q) => {
        const got = perQuestion.get(q.id);
        return { id: q.id, prompt: q.prompt, kind: q.kind, choices: q.choices, weight: q.weight, required: q.required, answer: answers.find((a) => a.questionId === q.id)?.value ?? '', score: got === undefined ? null : Math.round((got.score / got.n) * 100) / 100, comments: got?.comments ?? [] };
      }),
      documents: docs.map((d) => ({ id: d.id, name: d.name, held: held.get(d.id) ?? null })),
      result: {
        reasonCode: e.reasonCode,
        comment: e.decisionComment,
        revisionDue: e.revisionDue,
        validFrom: e.validFrom,
        validUntil: e.validUntil,
        maxOrderValue: e.maxOrderValue,
        conditionsNote: e.conditionsNote,
        suspendedBecause: e.suspendedBecause,
        totalScore: decided && c.showTotalScore ? e.totalScore : null,
        maxScore: decided && c.showTotalScore ? e.maxScore : null,
        passMarkPercent: decided && c.showPassMark ? c.passMarkPercent : null,
        evaluatorComments: comments,
      },
    };
  }

  async saveAnswers(actor: PortalActor, entryId: string, answers: Record<string, string>): Promise<void> {
    this.mayApply(actor);
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select({ e: prequalEntries }).from(prequalEntries).where(and(eq(prequalEntries.id, entryId), eq(prequalEntries.vendorId, actor.vendorId))).for('update');
      if (row === undefined) throw new ProfileError('NOT_FOUND', 'That application does not exist.');
      if (!(EDITABLE as readonly string[]).includes(row.e.status)) throw new ProfileError('NOT_EDITABLE', 'This application can no longer be changed.');
      const questions = await tx.select().from(categoryQuestions).where(eq(categoryQuestions.categoryId, row.e.categoryId));
      const asked = questions.map((q) => ({ id: q.id, prompt: q.prompt, kind: q.kind, choices: q.choices, required: q.required }));
      const problems = answerProblems(asked, answers, false);
      if (Object.keys(problems).length > 0) throw new ProfileError('INVALID', Object.values(problems)[0] ?? 'Check your answers.', problems);
      await tx.delete(prequalAnswers).where(eq(prequalAnswers.entryId, entryId));
      const rows = questions.flatMap((q) => ((answers[q.id] ?? '').trim() === '' ? [] : [{ entryId, questionId: q.id, value: (answers[q.id] ?? '').trim() }]));
      if (rows.length > 0) await tx.insert(prequalAnswers).values(rows);
    });
  }

  async submit(actor: PortalActor, entryId: string): Promise<void> {
    this.mayApply(actor);
    const categoryName = await this.db.transaction(async (tx) => {
      const [row] = await tx.select({ e: prequalEntries, name: procurementCategories.name }).from(prequalEntries).innerJoin(procurementCategories, eq(procurementCategories.id, prequalEntries.categoryId)).where(and(eq(prequalEntries.id, entryId), eq(prequalEntries.vendorId, actor.vendorId))).for('update', { of: prequalEntries });
      if (row === undefined) throw new ProfileError('NOT_FOUND', 'That application does not exist.');
      if (!(EDITABLE as readonly string[]).includes(row.e.status)) throw new ProfileError('NOT_EDITABLE', 'This application was already sent.');
      const [questions, answers, docs, held] = await Promise.all([
        tx.select().from(categoryQuestions).where(eq(categoryQuestions.categoryId, row.e.categoryId)),
        tx.select().from(prequalAnswers).where(eq(prequalAnswers.entryId, entryId)),
        tx.select({ id: vendorDocumentTypes.id, name: vendorDocumentTypes.name }).from(categoryDocuments).innerJoin(vendorDocumentTypes, eq(vendorDocumentTypes.id, categoryDocuments.documentTypeId)).where(eq(categoryDocuments.categoryId, row.e.categoryId)),
        heldDocumentTypes(this.db, actor.vendorId),
      ]);
      const given = Object.fromEntries(answers.map((a) => [a.questionId, a.value]));
      const problems = answerProblems(questions.map((q) => ({ id: q.id, prompt: q.prompt, kind: q.kind, choices: q.choices, required: q.required })), given, true);
      if (Object.keys(problems).length > 0) throw new ProfileError('INCOMPLETE', 'Answer every required question first.', problems);
      const missing = docs.filter((d) => !held.has(d.id));
      if (missing.length > 0) throw new ProfileError('DOCUMENTS_MISSING', `Upload ${missing.map((d) => d.name.toLowerCase()).join(', ')} on your attachments page first.`);
      await tx.delete(prequalScores).where(eq(prequalScores.entryId, entryId));
      await tx.update(prequalEntries).set({ status: 'submitted', submittedAt: new Date(), updatedAt: new Date() }).where(eq(prequalEntries.id, entryId));
      return row.name;
    });
    await this.event(actor.vendorId, 'prequalification_submitted', actor, { entryId });
    await this.notify?.prequalSubmitted(actor.vendorId, categoryName);
  }

  async withdraw(actor: PortalActor, entryId: string): Promise<void> {
    this.mayApply(actor);
    const done = await this.db.update(prequalEntries).set({ status: 'withdrawn', updatedAt: new Date() }).where(and(eq(prequalEntries.id, entryId), eq(prequalEntries.vendorId, actor.vendorId), inArray(prequalEntries.status, [...WITHDRAWABLE]))).returning({ id: prequalEntries.id });
    if (done.length === 0) throw new ProfileError('NOT_FOUND', 'That application cannot be withdrawn.');
    await this.event(actor.vendorId, 'prequalification_withdrawn', actor, { entryId });
  }
}
