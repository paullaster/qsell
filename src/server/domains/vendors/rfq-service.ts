import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { procurementCategories, rfqAddenda, rfqEvents, rfqInvitations, rfqLines, rfqQuestions, rfqQuotes, rfqs, vendors, type RfqStatus } from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import { checkRfqHeader, checkRfqLine, type RfqHeaderForm, type RfqLineForm } from '@/lib/rfq';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import type { VendorNotifier } from './notifier';
import type { PrequalLifecycle } from './prequal-lifecycle';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

const HOUR = 3_600_000;
const MAX_LINES = 200;
const MAX_INVITEES = 50;

/** A buyer's local `YYYY-MM-DDTHH:mm` becomes an instant. The server's own zone is the company's, as everywhere else here. */
export const parseDeadline = (local: string): Date => new Date(local.length === 16 ? `${local}:00` : local);

export interface RfqListFilter {
  status?: string;
  before?: { createdAt: string; id: string } | null;
  limit?: number;
}

/**
 * The request for quotation as a document (design doc §8.2–8.3): written as a draft, sent to vendors who are qualified in its
 * category, kept fixed once issued (changes go out as numbered addenda), closed at its deadline or early, and either awarded or
 * cancelled. Every step is written to the request's history with who, why and from where.
 */
export class RfqService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly numbering: NumberSeriesService,
    private readonly qualification: PrequalLifecycle,
    private readonly notify?: VendorNotifier,
  ) {}

  async event(tx: Tx | DrizzleDb, ctx: { actor: { type: 'user' | 'system' | 'job' | 'integration'; id: string | null } }, rfqId: string, event: string, extra: { vendorId?: string | null; reason?: string | null; data?: Record<string, unknown> } = {}): Promise<void> {
    await tx.insert(rfqEvents).values({ rfqId, vendorId: extra.vendorId ?? null, event, reasonText: extra.reason ?? null, data: extra.data ?? {}, actorType: ctx.actor.type, actorId: ctx.actor.id });
  }

  private async lock(tx: Tx, companyId: string, rfqId: string) {
    const [r] = await tx.select().from(rfqs).where(and(eq(rfqs.companyId, companyId), eq(rfqs.id, rfqId))).for('update');
    if (r === undefined) throw new FinanceError('NOT_FOUND', 'That request for quotation does not exist.');
    return r;
  }

  private cleanLines(lines: RfqLineForm[]): RfqLineForm[] {
    if (lines.length === 0) throw new FinanceError('INVALID', 'Add at least one line: what you want to buy.');
    if (lines.length > MAX_LINES) throw new FinanceError('TOO_MANY', `A request can have at most ${String(MAX_LINES)} lines.`);
    lines.forEach((l, i) => {
      const first = Object.values(checkRfqLine(l))[0];
      if (has(first)) throw new FinanceError('INVALID', `Line ${String(i + 1)}: ${first}`);
    });
    return lines;
  }

  /** Creates (id null) or rewrites a draft: its header and lines together, in one transaction. */
  async saveDraft(ctx: FinanceContext, id: string | null, header: RfqHeaderForm, lines: RfqLineForm[]): Promise<{ id: string }> {
    const problems = checkRfqHeader(header);
    const first = Object.values(problems)[0];
    if (has(first)) throw new FinanceError('INVALID', first);
    this.cleanLines(lines);
    const deadline = parseDeadline(header.deadline);
    if (Number.isNaN(deadline.getTime())) throw new FinanceError('INVALID', 'Choose the date and time quotes are due.');
    return await this.db.transaction(async (tx) => {
      const [cat] = await tx.select({ status: procurementCategories.status }).from(procurementCategories).where(and(eq(procurementCategories.companyId, ctx.companyId), eq(procurementCategories.id, header.categoryId)));
      if (cat === undefined || cat.status === 'archived') throw new FinanceError('NOT_FOUND', 'That category does not exist or is archived.');
      const values = {
        title: header.title.trim(),
        categoryId: header.categoryId,
        description: trimToNull(header.description),
        terms: trimToNull(header.terms),
        requiredBy: trimToNull(header.requiredBy),
        deadline,
        validityDays: Number(header.validityDays),
        currency: header.currency.trim().toUpperCase(),
        sealed: header.sealed,
        allowPartial: header.allowPartial,
        allowAlternatives: header.allowAlternatives,
        estimatedValue: trimToNull(header.estimatedValue),
        updatedAt: new Date(),
      };
      let rfqId: string;
      if (id === null) {
        const [made] = await tx.insert(rfqs).values({ companyId: ctx.companyId, ...values, buyerId: ctx.actor.id, createdBy: ctx.actor.id }).returning({ id: rfqs.id });
        if (made === undefined) throw new FinanceError('NOT_SAVED', 'The request could not be saved.');
        rfqId = made.id;
        await this.event(tx, ctx, rfqId, 'created');
      } else {
        const r = await this.lock(tx, ctx.companyId, id);
        if (r.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'Only a draft can be edited. Send an addendum to change an issued request.');
        await tx.update(rfqs).set(values).where(eq(rfqs.id, id));
        await tx.delete(rfqLines).where(eq(rfqLines.rfqId, id));
        rfqId = id;
      }
      await tx.insert(rfqLines).values(lines.map((l, i) => ({ rfqId, position: i, productId: trimToNull(l.productId), description: l.description.trim(), specification: trimToNull(l.specification), quantity: l.quantity.trim(), unit: l.unit.trim(), requiredDate: trimToNull(l.requiredDate) })));
      return { id: rfqId };
    });
  }

  /** Chooses who is invited. Only vendors qualified in the category (or a category inside it) are accepted. */
  async setInvitees(ctx: FinanceContext, rfqId: string, vendorIds: string[], today: string = businessDate()): Promise<void> {
    const wanted = [...new Set(vendorIds)];
    if (wanted.length > MAX_INVITEES) throw new FinanceError('TOO_MANY', `Invite at most ${String(MAX_INVITEES)} vendors to one request.`);
    await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, rfqId);
      if (r.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'Invitations are chosen while the request is a draft.');
      const qualified = new Set(await this.qualification.qualifiedVendorIds(ctx.companyId, r.categoryId, today));
      const bad = wanted.filter((v) => !qualified.has(v));
      if (bad.length > 0) {
        const names = await tx.select({ name: vendors.legalName }).from(vendors).where(inArray(vendors.id, bad));
        throw new FinanceError('NOT_QUALIFIED', `Not qualified in this category: ${names.length === 0 ? 'an unknown vendor' : names.map((n) => n.name).join(', ')}. Only qualified vendors can be invited.`);
      }
      await tx.delete(rfqInvitations).where(eq(rfqInvitations.rfqId, rfqId));
      if (wanted.length > 0) await tx.insert(rfqInvitations).values(wanted.map((vendorId) => ({ rfqId, vendorId })));
    });
  }

  async issue(ctx: FinanceContext, rfqId: string, now: Date = new Date()): Promise<{ number: string }> {
    const done = await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, rfqId);
      if (r.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'This request was already issued.');
      if (r.deadline.getTime() < now.getTime() + HOUR) throw new FinanceError('DEADLINE_TOO_SOON', 'Quotes must be due at least an hour from now. Change the deadline first.');
      const [lineCount] = await tx.select({ n: sql<number>`count(*)::int` }).from(rfqLines).where(eq(rfqLines.rfqId, rfqId));
      if ((lineCount?.n ?? 0) === 0) throw new FinanceError('INVALID', 'Add at least one line before issuing.');
      const invited = await tx.select({ vendorId: rfqInvitations.vendorId }).from(rfqInvitations).where(eq(rfqInvitations.rfqId, rfqId));
      if (invited.length === 0) throw new FinanceError('NO_INVITEES', 'Invite at least one qualified vendor before issuing.');
      const qualified = new Set(await this.qualification.qualifiedVendorIds(ctx.companyId, r.categoryId, businessDate(now)));
      const lost = invited.filter((i) => !qualified.has(i.vendorId));
      if (lost.length > 0) throw new FinanceError('NOT_QUALIFIED', 'A vendor you invited is no longer qualified in this category. Choose the invitations again.');
      const { number } = await this.numbering.assign('rfq', { companyId: ctx.companyId, branchId: null, date: businessDate(now), document: { kind: 'rfq', id: rfqId } }, tx);
      await tx.update(rfqs).set({ status: 'issued', number, issuedAt: now, opensAt: r.sealed ? r.deadline : now, updatedAt: now }).where(eq(rfqs.id, rfqId));
      await tx.update(rfqInvitations).set({ invitedAt: now }).where(eq(rfqInvitations.rfqId, rfqId));
      await this.event(tx, ctx, rfqId, 'issued', { data: { number, invited: invited.length } });
      return { number, title: r.title, deadline: r.deadline, vendorIds: invited.map((i) => i.vendorId), currency: r.currency };
    });
    await this.notify?.rfqInvited(done.vendorIds, done.number, done.title, done.deadline);
    return { number: done.number };
  }

  /** Closes a request before its deadline. Quotes open at that moment. */
  async closeEarly(ctx: FinanceContext, rfqId: string, reason: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the request is closed early.');
    const d = await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, rfqId);
      if (r.status !== 'issued') throw new FinanceError('NOT_ISSUED', 'Only a request that is open for quotes can be closed.');
      await tx.update(rfqs).set({ status: 'closed', closedAt: now, closeReason: text.slice(0, 500), opensAt: r.sealed ? now : r.opensAt, updatedAt: now }).where(eq(rfqs.id, rfqId));
      await this.event(tx, ctx, rfqId, 'closed_early', { reason: text.slice(0, 500) });
      return await this.invitees(tx, rfqId, r);
    });
    await this.notify?.rfqClosed(d.vendorIds, d.rfqNumber, d.title, text.slice(0, 500));
  }

  /** The worker closes every request whose deadline has passed. Returns how many. */
  async closeDue(now: Date = new Date()): Promise<number> {
    let closed = 0;
    for (;;) {
      const batch = await this.db.transaction(async (tx) => {
        const due = await tx.select().from(rfqs).where(and(eq(rfqs.status, 'issued'), lt(rfqs.deadline, now))).orderBy(asc(rfqs.deadline)).limit(50).for('update', { skipLocked: true });
        for (const r of due) {
          await tx.update(rfqs).set({ status: 'closed', closedAt: now, closeReason: 'The deadline passed', updatedAt: now }).where(eq(rfqs.id, r.id));
          await this.event(tx, { actor: { type: 'job', id: null } }, r.id, 'closed_at_deadline');
        }
        return due.length;
      });
      closed += batch;
      if (batch < 50) return closed;
    }
  }

  private async invitees(tx: Tx | DrizzleDb, rfqId: string, r: { number: string | null; title: string }) {
    const rows = await tx.select({ vendorId: rfqInvitations.vendorId }).from(rfqInvitations).where(and(eq(rfqInvitations.rfqId, rfqId), sql`${rfqInvitations.status} <> 'declined'`));
    return { vendorIds: rows.map((x) => x.vendorId), rfqNumber: r.number ?? '', title: r.title };
  }

  /**
   * Extends the deadline of an open request, or reopens a closed one, with a reason, and tells every invitee in a numbered addendum.
   * A sealed request whose quotes have already been opened cannot be reopened: that would let some vendors see before others.
   */
  async extend(ctx: FinanceContext, rfqId: string, newDeadline: string, reason: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the deadline moves.');
    const deadline = parseDeadline(newDeadline);
    if (Number.isNaN(deadline.getTime()) || deadline.getTime() < now.getTime() + HOUR) throw new FinanceError('INVALID', 'The new deadline must be at least an hour from now.');
    const d = await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, rfqId);
      if (r.status !== 'issued' && r.status !== 'closed') throw new FinanceError('NOT_ISSUED', 'Only an open or closed request can have its deadline moved.');
      if (r.status === 'closed') {
        const [seen] = await tx.select({ id: rfqQuotes.id }).from(rfqQuotes).where(and(eq(rfqQuotes.rfqId, rfqId), eq(rfqQuotes.status, 'submitted'))).limit(1);
        if (r.sealed && seen !== undefined) throw new FinanceError('ALREADY_OPENED', 'Quotes were already opened, so this request cannot be reopened. Cancel it and issue a new one.');
      }
      if (deadline.getTime() <= r.deadline.getTime() && r.status === 'issued') throw new FinanceError('INVALID', 'The new deadline must be later than the current one.');
      await tx.update(rfqs).set({ status: 'issued', deadline, closedAt: null, closeReason: null, opensAt: r.sealed ? deadline : r.opensAt, reminded48: false, reminded4: false, updatedAt: now }).where(eq(rfqs.id, rfqId));
      const body = `The deadline moved. Reason: ${text.slice(0, 500)}`;
      await this.addendumIn(tx, ctx, rfqId, body, r.deadline, deadline);
      await this.event(tx, ctx, rfqId, r.status === 'closed' ? 'reopened' : 'deadline_extended', { reason: text.slice(0, 500), data: { from: r.deadline.toISOString(), to: deadline.toISOString() } });
      return { ...(await this.invitees(tx, rfqId, r)), body };
    });
    await this.notify?.rfqAddendum(d.vendorIds, d.rfqNumber, d.title, d.body, deadline);
  }

  private async addendumIn(tx: Tx, ctx: { actor: { id: string | null } }, rfqId: string, body: string, before: Date | null, after: Date | null): Promise<number> {
    const [top] = await tx.select({ n: sql<number>`COALESCE(max(number), 0)::int` }).from(rfqAddenda).where(eq(rfqAddenda.rfqId, rfqId));
    const number = (top?.n ?? 0) + 1;
    await tx.insert(rfqAddenda).values({ rfqId, number, body, deadlineBefore: before, deadlineAfter: after, createdBy: ctx.actor.id });
    return number;
  }

  /** A clarification sent to every invitee, optionally with a later deadline. */
  async addendum(ctx: FinanceContext, rfqId: string, body: string, newDeadline: string, now: Date = new Date()): Promise<{ number: number }> {
    const text = trimToNull(body);
    if (!has(text) || text.length < 5) throw new FinanceError('INVALID', 'Write the clarification (at least a few words).');
    const later = trimToNull(newDeadline);
    const deadline = later === null ? null : parseDeadline(later);
    if (deadline !== null && Number.isNaN(deadline.getTime())) throw new FinanceError('INVALID', 'Choose a valid date and time.');
    const d = await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, rfqId);
      if (r.status !== 'issued') throw new FinanceError('NOT_ISSUED', 'Clarifications go out while the request is open for quotes.');
      if (deadline !== null && (deadline.getTime() <= r.deadline.getTime() || deadline.getTime() < now.getTime() + HOUR)) throw new FinanceError('INVALID', 'A new deadline must be later than the current one.');
      if (deadline !== null) await tx.update(rfqs).set({ deadline, opensAt: r.sealed ? deadline : r.opensAt, reminded48: false, reminded4: false, updatedAt: now }).where(eq(rfqs.id, rfqId));
      const number = await this.addendumIn(tx, ctx, rfqId, text.slice(0, 2000), deadline === null ? null : r.deadline, deadline);
      await this.event(tx, ctx, rfqId, 'addendum', { data: { number } });
      return { addendumNumber: number, ...(await this.invitees(tx, rfqId, r)) };
    });
    await this.notify?.rfqAddendum(d.vendorIds, d.rfqNumber, d.title, text.slice(0, 2000), deadline);
    return { number: d.addendumNumber };
  }

  async cancel(ctx: FinanceContext, rfqId: string, reason: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the request is cancelled.');
    const d = await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, rfqId);
      if (r.status === 'awarded' || r.status === 'cancelled') throw new FinanceError('NOT_ALLOWED', `A request that is ${r.status} cannot be cancelled.`);
      await tx.update(rfqs).set({ status: 'cancelled', cancelledAt: now, cancelReason: text.slice(0, 500), updatedAt: now }).where(eq(rfqs.id, rfqId));
      await this.event(tx, ctx, rfqId, 'cancelled', { reason: text.slice(0, 500) });
      return { ...(await this.invitees(tx, rfqId, r)), wasDraft: r.status === 'draft' };
    });
    if (!d.wasDraft) await this.notify?.rfqCancelled(d.vendorIds, d.rfqNumber, d.title, text.slice(0, 500));
  }

  // ── Vendor questions: the staff side ─────────────────────────────────────────────────────────

  /** Answers a vendor's question. Only a published answer reaches the other invitees, and it never names who asked. */
  async answer(ctx: FinanceContext, questionId: string, answer: string, publish: boolean): Promise<void> {
    const text = trimToNull(answer);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Write the answer.');
    const d = await this.db.transaction(async (tx) => {
      const [q] = await tx.select({ q: rfqQuestions, r: rfqs }).from(rfqQuestions).innerJoin(rfqs, eq(rfqs.id, rfqQuestions.rfqId)).where(and(eq(rfqQuestions.id, questionId), eq(rfqs.companyId, ctx.companyId))).for('update', { of: rfqQuestions });
      if (q === undefined) throw new FinanceError('NOT_FOUND', 'That question does not exist.');
      if (q.r.status !== 'issued') throw new FinanceError('NOT_ISSUED', 'Questions are answered while the request is open for quotes.');
      await tx.update(rfqQuestions).set({ answer: text.slice(0, 2000), published: publish, answeredBy: ctx.actor.id, answeredAt: new Date() }).where(eq(rfqQuestions.id, questionId));
      await this.event(tx, ctx, q.r.id, publish ? 'question_answered_published' : 'question_answered', { vendorId: q.q.vendorId });
      return { ...(await this.invitees(tx, q.r.id, q.r)), asker: q.q.vendorId, question: q.q.body };
    });
    if (publish) await this.notify?.rfqAddendum(d.vendorIds, d.rfqNumber, d.title, `Question: ${d.question}\nAnswer: ${text.slice(0, 2000)}`, null);
  }

  // ── Reading ──────────────────────────────────────────────────────────────────────────────────

  async list(companyId: string, f: RfqListFilter = {}) {
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 100);
    const conds = [eq(rfqs.companyId, companyId)];
    if (has(f.status)) conds.push(eq(rfqs.status, f.status as RfqStatus));
    if (f.before) conds.push(sql`(${rfqs.createdAt}::text, ${rfqs.id}::text) < (${f.before.createdAt}, ${f.before.id})`);
    const found = await this.db
      .select({ r: rfqs, category: procurementCategories.name, invited: sql<number>`(SELECT count(*)::int FROM rfq_invitations i WHERE i.rfq_id = ${rfqs.id})`, stamp: sql<string>`${rfqs.createdAt}::text` })
      .from(rfqs)
      .innerJoin(procurementCategories, eq(procurementCategories.id, rfqs.categoryId))
      .where(and(...conds))
      .orderBy(desc(rfqs.createdAt), desc(rfqs.id))
      .limit(limit + 1);
    const page = found.slice(0, limit);
    const last = page.at(-1);
    return { rows: page.map((x) => ({ ...x.r, categoryName: x.category, invited: x.invited })), next: found.length > limit && last !== undefined ? { createdAt: last.stamp, id: last.r.id } : null };
  }

  async get(companyId: string, rfqId: string) {
    const [head] = await this.db.select({ r: rfqs, category: procurementCategories.name }).from(rfqs).innerJoin(procurementCategories, eq(procurementCategories.id, rfqs.categoryId)).where(and(eq(rfqs.companyId, companyId), eq(rfqs.id, rfqId)));
    if (head === undefined) return null;
    const [lines, invitations, addenda, questions, events] = await Promise.all([
      this.db.select().from(rfqLines).where(eq(rfqLines.rfqId, rfqId)).orderBy(asc(rfqLines.position)),
      this.db.select({ i: rfqInvitations, name: vendors.legalName, number: vendors.number }).from(rfqInvitations).innerJoin(vendors, eq(vendors.id, rfqInvitations.vendorId)).where(eq(rfqInvitations.rfqId, rfqId)).orderBy(asc(vendors.legalName)),
      this.db.select().from(rfqAddenda).where(eq(rfqAddenda.rfqId, rfqId)).orderBy(asc(rfqAddenda.number)),
      this.db.select({ q: rfqQuestions, name: vendors.legalName }).from(rfqQuestions).innerJoin(vendors, eq(vendors.id, rfqQuestions.vendorId)).where(eq(rfqQuestions.rfqId, rfqId)).orderBy(asc(rfqQuestions.createdAt)),
      this.db.select().from(rfqEvents).where(eq(rfqEvents.rfqId, rfqId)).orderBy(desc(rfqEvents.id)).limit(100),
    ]);
    return { rfq: head.r, categoryName: head.category, lines, invitations, addenda, questions, events };
  }

  /** Reminds invited vendors that have not quoted, 48 hours and 4 hours before the deadline, once each. Returns how many were sent. */
  async remind(now: Date = new Date()): Promise<number> {
    let sent = 0;
    // The nearer reminder goes first and covers the farther one, so nobody is reminded twice in one run.
    for (const [hours, flag] of [[4, 'reminded4'], [48, 'reminded48']] as const) {
      const column = flag === 'reminded48' ? rfqs.reminded48 : rfqs.reminded4;
      const due = await this.db
        .update(rfqs)
        .set(flag === 'reminded4' ? { reminded4: true, reminded48: true } : { reminded48: true })
        .where(and(eq(rfqs.status, 'issued'), eq(column, false), sql`${rfqs.deadline} > ${now.toISOString()}::timestamptz`, sql`${rfqs.deadline} <= ${new Date(now.getTime() + hours * HOUR).toISOString()}::timestamptz`))
        .returning({ id: rfqs.id, number: rfqs.number, title: rfqs.title, deadline: rfqs.deadline });
      for (const r of due) {
        const waiting = await this.db
          .select({ vendorId: rfqInvitations.vendorId })
          .from(rfqInvitations)
          .where(and(eq(rfqInvitations.rfqId, r.id), sql`${rfqInvitations.status} <> 'declined'`, sql`NOT EXISTS (SELECT 1 FROM rfq_quotes q WHERE q.rfq_id = ${r.id}::uuid AND q.vendor_id = ${rfqInvitations.vendorId} AND q.status = 'submitted')`));
        for (const w of waiting) {
          await this.notify?.rfqReminder(w.vendorId, r.number ?? '', r.title, r.deadline, hours);
          sent += 1;
        }
      }
    }
    return sent;
  }
}
