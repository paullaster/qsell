import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { procurementCategories, reasonCodes, rfqAddenda, rfqAwards, rfqEvents, rfqInvitations, rfqLines, rfqQuestions, rfqQuoteLines, rfqQuotes, rfqs } from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import { checkQuoteLines, quoteTotals, vendorStage, type AskedLine, type QuoteLineInput } from '@/lib/rfq';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { VendorNotifier } from './notifier';
import type { PrequalLifecycle } from './prequal-lifecycle';
import { ProfileError, type PortalActor } from './profile-service';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

const MAX_QUESTIONS = 20;
const cents = (n: number): string => (n / 100).toFixed(2);

export interface QuoteInput {
  paymentTerms: string;
  deliveryTerms: string;
  validUntil: string;
  notes: string;
  lines: QuoteLineInput[];
}

/**
 * A vendor's side of a request for quotation (design doc §8.4): every request it was invited to in every stage, the quote as a
 * versioned document (a submitted version never changes), questions, declining, and the result. The vendor comes from the session;
 * a request it was not invited to does not exist as far as it can tell.
 */
export class RfqPortalService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly qualification: PrequalLifecycle,
    private readonly notify?: VendorNotifier,
  ) {}

  private mayAnswer(actor: PortalActor): void {
    if (actor.portalRole !== 'owner' && actor.portalRole !== 'sales') throw new ProfileError('NOT_ALLOWED', 'Only the owner or the sales person can answer a request for quotation.');
  }

  /** Every request the vendor was invited to, newest first, each with the one word that says where it stands. */
  async list(vendorId: string, before: { issuedAt: string; id: string } | null = null, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 100);
    const found = await this.db
      .select({
        id: rfqs.id,
        number: rfqs.number,
        title: rfqs.title,
        status: rfqs.status,
        deadline: rfqs.deadline,
        category: procurementCategories.name,
        inviteStatus: rfqInvitations.status,
        decision: rfqInvitations.decision,
        stamp: sql<string>`${rfqs.issuedAt}::text`,
        hasSubmitted: sql<boolean>`EXISTS (SELECT 1 FROM rfq_quotes q WHERE q.rfq_id = ${rfqs.id} AND q.vendor_id = ${vendorId}::uuid AND q.status = 'submitted')`,
        hasDraft: sql<boolean>`EXISTS (SELECT 1 FROM rfq_quotes q WHERE q.rfq_id = ${rfqs.id} AND q.vendor_id = ${vendorId}::uuid AND q.status = 'draft')`,
        wasAwarded: sql<boolean>`EXISTS (SELECT 1 FROM rfq_awards a WHERE a.rfq_id = ${rfqs.id} AND a.vendor_id = ${vendorId}::uuid)`,
      })
      .from(rfqInvitations)
      .innerJoin(rfqs, eq(rfqs.id, rfqInvitations.rfqId))
      .innerJoin(procurementCategories, eq(procurementCategories.id, rfqs.categoryId))
      .where(and(eq(rfqInvitations.vendorId, vendorId), sql`${rfqs.status} <> 'draft'`, before === null ? sql`true` : sql`(${rfqs.issuedAt}::text, ${rfqs.id}::text) < (${before.issuedAt}, ${before.id})`))
      .orderBy(desc(rfqs.issuedAt), desc(rfqs.id))
      .limit(take + 1);
    const page = found.slice(0, take);
    const last = page.at(-1);
    return {
      rows: page.map((r) => ({ id: r.id, number: r.number, title: r.title, category: r.category, deadline: r.deadline.toISOString(), stage: vendorStage({ rfqStatus: r.status, inviteStatus: r.inviteStatus, decision: r.decision, hasSubmitted: r.hasSubmitted, hasDraft: r.hasDraft, wasAwarded: r.wasAwarded }) })),
      next: found.length > take && last !== undefined ? { issuedAt: last.stamp, id: last.id } : null,
    };
  }

  /** May this vendor still write or send a quote? Until the deadline, or until the date a revision was asked for. */
  private window(r: { status: string; deadline: Date }, inv: { status: string; decision: string; revisionDue: Date | null }, now: Date): { open: boolean; until: Date | null } {
    if (inv.status === 'declined') return { open: false, until: null };
    if (r.status === 'issued' && now.getTime() <= r.deadline.getTime()) return { open: true, until: r.deadline };
    if (inv.decision === 'revision_requested' && inv.revisionDue !== null && now.getTime() <= inv.revisionDue.getTime() && (r.status === 'issued' || r.status === 'closed')) return { open: true, until: inv.revisionDue };
    return { open: false, until: null };
  }

  private async invitationOf(db: Tx | DrizzleDb, vendorId: string, rfqId: string) {
    const [row] = await db
      .select({ r: rfqs, i: rfqInvitations })
      .from(rfqInvitations)
      .innerJoin(rfqs, eq(rfqs.id, rfqInvitations.rfqId))
      .where(and(eq(rfqInvitations.rfqId, rfqId), eq(rfqInvitations.vendorId, vendorId), sql`${rfqs.status} <> 'draft'`));
    if (row === undefined) throw new ProfileError('NOT_FOUND', 'That request does not exist.');
    return row;
  }

  async load(actor: PortalActor, rfqId: string, now: Date = new Date()) {
    const { r, i } = await this.invitationOf(this.db, actor.vendorId, rfqId);
    if (i.status === 'invited') {
      await this.db.update(rfqInvitations).set({ status: 'opened', openedAt: now }).where(and(eq(rfqInvitations.rfqId, rfqId), eq(rfqInvitations.vendorId, actor.vendorId), eq(rfqInvitations.status, 'invited')));
    }
    const [category, lines, addenda, questions, quotes, awards, reason] = await Promise.all([
      this.db.select({ name: procurementCategories.name }).from(procurementCategories).where(eq(procurementCategories.id, r.categoryId)),
      this.db.select().from(rfqLines).where(eq(rfqLines.rfqId, rfqId)).orderBy(asc(rfqLines.position)),
      this.db.select().from(rfqAddenda).where(eq(rfqAddenda.rfqId, rfqId)).orderBy(asc(rfqAddenda.number)),
      this.db.select().from(rfqQuestions).where(eq(rfqQuestions.rfqId, rfqId)).orderBy(asc(rfqQuestions.createdAt)),
      this.db.select().from(rfqQuotes).where(and(eq(rfqQuotes.rfqId, rfqId), eq(rfqQuotes.vendorId, actor.vendorId))).orderBy(desc(rfqQuotes.version)),
      this.db.select().from(rfqAwards).where(and(eq(rfqAwards.rfqId, rfqId), eq(rfqAwards.vendorId, actor.vendorId))),
      i.decisionReason === null ? Promise.resolve([]) : this.db.select({ description: reasonCodes.description }).from(reasonCodes).where(and(eq(reasonCodes.companyId, r.companyId), eq(reasonCodes.code, i.decisionReason))),
    ]);
    const quoteLines = quotes.length === 0 ? [] : await this.db.select().from(rfqQuoteLines).where(sql`${rfqQuoteLines.quoteId} IN (${sql.join(quotes.map((q) => sql`${q.id}::uuid`), sql`, `)})`);
    const w = this.window(r, i, now);
    const activeSubmitted = quotes.find((q) => q.status === 'submitted');
    const draft = quotes.find((q) => q.status === 'draft');
    const stage = vendorStage({ rfqStatus: r.status, inviteStatus: i.status === 'invited' ? 'opened' : i.status, decision: i.decision, hasSubmitted: activeSubmitted !== undefined, hasDraft: draft !== undefined, wasAwarded: awards.length > 0 });
    const lineOf = (qid: string) => quoteLines.filter((l) => l.quoteId === qid).map((l) => ({ rfqLineId: l.rfqLineId, noBid: l.noBid, isAlternative: l.isAlternative, unitPrice: l.unitPrice ?? '', quantity: l.quantity ?? '', taxRate: l.taxRate, leadTimeDays: l.leadTimeDays === null ? '' : String(l.leadTimeDays), brand: l.brand ?? '', warranty: l.warranty ?? '', note: l.note ?? '' }));
    const asBlock = (q: (typeof quotes)[number]) => ({ id: q.id, version: q.version, status: q.status, paymentTerms: q.paymentTerms ?? '', deliveryTerms: q.deliveryTerms ?? '', validUntil: q.validUntil ?? '', notes: q.notes ?? '', subtotal: q.subtotal, taxTotal: q.taxTotal, total: q.total, submittedAt: q.submittedAt?.toISOString() ?? null, lines: lineOf(q.id) });
    const base = draft ?? quotes.find((q) => q.status !== 'draft');
    return {
      id: r.id,
      number: r.number,
      title: r.title,
      status: r.status,
      stage,
      category: category[0]?.name ?? '',
      description: r.description,
      terms: r.terms,
      requiredBy: r.requiredBy,
      deadline: r.deadline.toISOString(),
      validityDays: r.validityDays,
      currency: r.currency,
      allowPartial: r.allowPartial,
      allowAlternatives: r.allowAlternatives,
      lines: lines.map((l) => ({ id: l.id, position: l.position, description: l.description, specification: l.specification, quantity: l.quantity, unit: l.unit, requiredDate: l.requiredDate })),
      addenda: addenda.map((a) => ({ number: a.number, body: a.body, at: a.createdAt.toISOString(), deadlineAfter: a.deadlineAfter?.toISOString() ?? null })),
      // Other vendors' questions are never shown; a published answer is, without saying who asked.
      questions: questions.filter((q) => q.vendorId === actor.vendorId || q.published).map((q) => ({ id: q.id, body: q.body, mine: q.vendorId === actor.vendorId, answer: q.published ? q.answer : null, at: q.createdAt.toISOString() })),
      canAnswer: actor.portalRole === 'owner' || actor.portalRole === 'sales',
      window: { open: w.open, until: w.until?.toISOString() ?? null },
      invitation: { status: i.status === 'invited' ? 'opened' : i.status, declineReason: i.declineReason },
      decision: { value: i.decision, reason: reason[0]?.description ?? null, comment: i.decisionComment, revisionDue: i.revisionDue?.toISOString() ?? null },
      submitted: activeSubmitted === undefined ? null : asBlock(activeSubmitted),
      draft: draft === undefined ? null : asBlock(draft),
      editable: base === undefined ? null : asBlock(base),
      history: quotes.filter((q) => q.status !== 'draft').map(asBlock),
      awards: awards.map((a) => ({ rfqLineId: a.rfqLineId, quantity: a.quantity, unitPrice: a.unitPrice })),
      /** May the vendor change its quote now, or must it withdraw the sent one first? */
      needsWithdrawal: w.open && activeSubmitted !== undefined && i.decision !== 'revision_requested',
    };
  }

  /** Saves the quote being written. Nothing is sent. The totals are worked out here from the lines. */
  async saveDraft(actor: PortalActor, rfqId: string, input: QuoteInput, now: Date = new Date()): Promise<{ version: number }> {
    this.mayAnswer(actor);
    return await this.db.transaction(async (tx) => {
      const [inv] = await tx.select().from(rfqInvitations).where(and(eq(rfqInvitations.rfqId, rfqId), eq(rfqInvitations.vendorId, actor.vendorId))).for('update');
      if (inv === undefined) throw new ProfileError('NOT_FOUND', 'That request does not exist.');
      const { r, i } = await this.invitationOf(tx, actor.vendorId, rfqId);
      const w = this.window(r, i, now);
      if (!w.open) throw new ProfileError('CLOSED', 'This request is no longer taking quotes.');
      const asked = await tx.select().from(rfqLines).where(eq(rfqLines.rfqId, rfqId));
      const problems = checkQuoteLines(asked.map((l): AskedLine => ({ id: l.id, description: l.description, quantity: Number(l.quantity) })), input.lines, r, false);
      if (Object.keys(problems).length > 0) throw new ProfileError('INVALID', Object.values(problems)[0] ?? 'Check the quote.', problems);
      if (input.validUntil !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(input.validUntil)) throw new ProfileError('INVALID', 'Use a date like 2026-12-31 for how long the quote holds.', { validUntil: 'Use a date like 2026-12-31.' });
      const versions = await tx.select().from(rfqQuotes).where(and(eq(rfqQuotes.rfqId, rfqId), eq(rfqQuotes.vendorId, actor.vendorId))).orderBy(desc(rfqQuotes.version));
      const draft = versions.find((q) => q.status === 'draft');
      if (draft === undefined && versions.some((q) => q.status === 'submitted') && i.decision !== 'revision_requested') throw new ProfileError('SUBMITTED', 'Your quote has been sent. Withdraw it first if you need to change it.');
      const totals = quoteTotals(input.lines);
      const header = { paymentTerms: trimToNull(input.paymentTerms)?.slice(0, 500) ?? null, deliveryTerms: trimToNull(input.deliveryTerms)?.slice(0, 500) ?? null, validUntil: trimToNull(input.validUntil), notes: trimToNull(input.notes)?.slice(0, 2000) ?? null, subtotal: cents(totals.subtotal), taxTotal: cents(totals.tax), total: cents(totals.total) };
      let quoteId: string;
      let version: number;
      if (draft === undefined) {
        version = (versions[0]?.version ?? 0) + 1;
        const [made] = await tx.insert(rfqQuotes).values({ rfqId, vendorId: actor.vendorId, version, ...header }).returning({ id: rfqQuotes.id });
        if (made === undefined) throw new ProfileError('NOT_SAVED', 'The quote could not be saved.');
        quoteId = made.id;
      } else {
        quoteId = draft.id;
        version = draft.version;
        await tx.update(rfqQuotes).set(header).where(eq(rfqQuotes.id, quoteId));
        await tx.delete(rfqQuoteLines).where(eq(rfqQuoteLines.quoteId, quoteId));
      }
      const kept = input.lines.filter((l) => l.noBid || l.unitPrice.trim() !== '');
      if (kept.length > 0) {
        await tx.insert(rfqQuoteLines).values(kept.map((l) => ({
          quoteId,
          rfqLineId: l.rfqLineId,
          noBid: l.noBid,
          isAlternative: l.isAlternative,
          unitPrice: l.noBid ? null : l.unitPrice.trim(),
          quantity: l.noBid ? null : l.quantity.trim(),
          taxRate: l.taxRate.trim() === '' ? '0' : l.taxRate.trim(),
          leadTimeDays: l.leadTimeDays.trim() === '' ? null : Number(l.leadTimeDays),
          brand: trimToNull(l.brand)?.slice(0, 120) ?? null,
          warranty: trimToNull(l.warranty)?.slice(0, 120) ?? null,
          note: trimToNull(l.note)?.slice(0, 500) ?? null,
        })));
      }
      return { version };
    });
  }

  /** Sends the draft. It is checked in full, still has to be from a qualified vendor, and from then on it is fixed. */
  async submit(actor: PortalActor, rfqId: string, companyId: string, now: Date = new Date()): Promise<{ version: number }> {
    this.mayAnswer(actor);
    const done = await this.db.transaction(async (tx) => {
      const [inv] = await tx.select().from(rfqInvitations).where(and(eq(rfqInvitations.rfqId, rfqId), eq(rfqInvitations.vendorId, actor.vendorId))).for('update');
      if (inv === undefined) throw new ProfileError('NOT_FOUND', 'That request does not exist.');
      const { r, i } = await this.invitationOf(tx, actor.vendorId, rfqId);
      if (!this.window(r, i, now).open) throw new ProfileError('CLOSED', 'This request is no longer taking quotes.');
      const [draft] = await tx.select().from(rfqQuotes).where(and(eq(rfqQuotes.rfqId, rfqId), eq(rfqQuotes.vendorId, actor.vendorId), eq(rfqQuotes.status, 'draft')));
      if (draft === undefined) throw new ProfileError('NO_DRAFT', 'Write your quote and save it first.');
      const [asked, stored] = await Promise.all([tx.select().from(rfqLines).where(eq(rfqLines.rfqId, rfqId)), tx.select().from(rfqQuoteLines).where(eq(rfqQuoteLines.quoteId, draft.id))]);
      const inputs: QuoteLineInput[] = stored.map((l) => ({ rfqLineId: l.rfqLineId, noBid: l.noBid, isAlternative: l.isAlternative, unitPrice: l.unitPrice ?? '', quantity: l.quantity ?? '', taxRate: l.taxRate, leadTimeDays: l.leadTimeDays === null ? '' : String(l.leadTimeDays), brand: l.brand ?? '', warranty: l.warranty ?? '', note: l.note ?? '' }));
      const problems = checkQuoteLines(asked.map((l): AskedLine => ({ id: l.id, description: l.description, quantity: Number(l.quantity) })), inputs, r, true);
      if (Object.keys(problems).length > 0) throw new ProfileError('INCOMPLETE', Object.values(problems)[0] ?? 'Check the quote.', problems);
      const holdUntil = new Date(now.getTime() + r.validityDays * 86_400_000).toISOString().slice(0, 10);
      if (draft.validUntil === null || draft.validUntil < holdUntil) throw new ProfileError('VALIDITY', `The quote must hold until at least ${holdUntil} (${String(r.validityDays)} days).`, { validUntil: `Hold the quote until ${holdUntil} or later.` });
      if ((await this.qualification.qualificationOf(companyId, actor.vendorId, r.categoryId, businessDate(now))) === null) throw new ProfileError('NOT_QUALIFIED', 'You are no longer qualified in this category, so you cannot send a quote. Check your prequalification.');
      const totals = quoteTotals(inputs);
      await tx.update(rfqQuotes).set({ status: 'submitted', submittedAt: now, submittedBy: actor.userId, subtotal: cents(totals.subtotal), taxTotal: cents(totals.tax), total: cents(totals.total) }).where(eq(rfqQuotes.id, draft.id));
      if (i.decision === 'revision_requested') await tx.update(rfqInvitations).set({ decision: 'pending', decisionReason: null, decisionComment: null, revisionDue: null, decidedAt: null, decidedBy: null }).where(and(eq(rfqInvitations.rfqId, rfqId), eq(rfqInvitations.vendorId, actor.vendorId)));
      await tx.insert(rfqEvents).values({ rfqId, vendorId: actor.vendorId, event: 'quote_submitted', data: { version: draft.version }, actorType: 'user', actorId: actor.userId });
      return { version: draft.version, number: r.number ?? '' };
    });
    await this.notify?.quoteReceived(actor.vendorId, done.number, done.version);
    return { version: done.version };
  }

  /** Takes a sent quote back so it can be changed; the sent version stays on record. */
  async withdraw(actor: PortalActor, rfqId: string, now: Date = new Date()): Promise<void> {
    this.mayAnswer(actor);
    await this.db.transaction(async (tx) => {
      await tx.select().from(rfqInvitations).where(and(eq(rfqInvitations.rfqId, rfqId), eq(rfqInvitations.vendorId, actor.vendorId))).for('update');
      const { r, i } = await this.invitationOf(tx, actor.vendorId, rfqId);
      if (!this.window(r, i, now).open) throw new ProfileError('CLOSED', 'This request is no longer taking changes.');
      const [sent] = await tx.select().from(rfqQuotes).where(and(eq(rfqQuotes.rfqId, rfqId), eq(rfqQuotes.vendorId, actor.vendorId), eq(rfqQuotes.status, 'submitted'))).orderBy(desc(rfqQuotes.version)).limit(1);
      if (sent === undefined) throw new ProfileError('NOT_FOUND', 'You have no sent quote to withdraw.');
      await tx.update(rfqQuotes).set({ status: 'withdrawn' }).where(eq(rfqQuotes.id, sent.id));
      await tx.insert(rfqEvents).values({ rfqId, vendorId: actor.vendorId, event: 'quote_withdrawn', data: { version: sent.version }, actorType: 'user', actorId: actor.userId });
    });
  }

  async decline(actor: PortalActor, rfqId: string, reason: string, now: Date = new Date()): Promise<void> {
    this.mayAnswer(actor);
    const text = trimToNull(reason);
    if (!has(text)) throw new ProfileError('INVALID', 'Say briefly why you are not bidding.');
    await this.db.transaction(async (tx) => {
      await tx.select().from(rfqInvitations).where(and(eq(rfqInvitations.rfqId, rfqId), eq(rfqInvitations.vendorId, actor.vendorId))).for('update');
      const { r, i } = await this.invitationOf(tx, actor.vendorId, rfqId);
      if (r.status !== 'issued' || now.getTime() > r.deadline.getTime()) throw new ProfileError('CLOSED', 'This request is no longer open.');
      if (i.status === 'declined') throw new ProfileError('ALREADY', 'You already declined this request.');
      const [sent] = await tx.select({ id: rfqQuotes.id }).from(rfqQuotes).where(and(eq(rfqQuotes.rfqId, rfqId), eq(rfqQuotes.vendorId, actor.vendorId), eq(rfqQuotes.status, 'submitted'))).limit(1);
      if (sent !== undefined) throw new ProfileError('SUBMITTED', 'You have sent a quote. Withdraw it before declining.');
      await tx.update(rfqInvitations).set({ status: 'declined', declineReason: text.slice(0, 500), declinedAt: now }).where(and(eq(rfqInvitations.rfqId, rfqId), eq(rfqInvitations.vendorId, actor.vendorId)));
      await tx.insert(rfqEvents).values({ rfqId, vendorId: actor.vendorId, event: 'declined_to_bid', reasonText: text.slice(0, 500), data: {}, actorType: 'user', actorId: actor.userId });
    });
  }

  /** A question for the buyer. Only the buyer sees it; if the answer is published, every invitee sees it without your name. */
  async ask(actor: PortalActor, rfqId: string, question: string, now: Date = new Date()): Promise<void> {
    this.mayAnswer(actor);
    const text = trimToNull(question);
    if (!has(text) || text.length < 5) throw new ProfileError('INVALID', 'Write your question (at least a few words).');
    const { r, i } = await this.invitationOf(this.db, actor.vendorId, rfqId);
    if (r.status !== 'issued' || now.getTime() > r.deadline.getTime() || i.status === 'declined') throw new ProfileError('CLOSED', 'Questions are taken while the request is open.');
    const [n] = await this.db.select({ n: sql<number>`count(*)::int` }).from(rfqQuestions).where(and(eq(rfqQuestions.rfqId, rfqId), eq(rfqQuestions.vendorId, actor.vendorId)));
    if ((n?.n ?? 0) >= MAX_QUESTIONS) throw new ProfileError('TOO_MANY', `You can ask at most ${String(MAX_QUESTIONS)} questions on one request.`);
    await this.db.insert(rfqQuestions).values({ rfqId, vendorId: actor.vendorId, body: text.slice(0, 1000) });
  }
}
