import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { bankAccounts, bankLedgerEntries, cashCustodyEntries, cashHandIns, deliveryDoorSettings, deliveryRiders, financeSettings, glAccounts, paymentMethods, users, type CashHandInRow } from '@/server/db/drizzle/schema';
import { HAND_IN_WORDS, approverProblem, custodyBalance, custodyWrites, fromCents, handInCheck, handInLines, handInProblem, toCents, type HandInStatus } from '@/lib/door-payment';
import { firstNonZero } from '@/lib/values';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { decodeCursor, encodeCursor } from '@/server/domains/lookups/request';
import type { PostingRequest } from '@/server/domains/finance/domain/types';
import { NO_SPECIAL_PERMISSIONS, type PostingEngine } from '@/server/domains/finance/engine';
import { FinanceError } from '@/server/domains/finance/errors';
import type { DocActor, DocRefusal, DocResult } from './documents';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

const fail = (reason: DocRefusal, message: string): { ok: false; reason: DocRefusal; message: string } => ({ ok: false, reason, message });
const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null);
const PAGE = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HandInView {
  id: string;
  number: string;
  riderId: string;
  riderName: string;
  status: HandInStatus;
  statusWords: string;
  expected: string;
  counted: string;
  difference: string;
  currency: string;
  toAccount: string;
  witnessName: string;
  note: string | null;
  countedBy: string;
  approvedBy: string | null;
  decisionReason: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/**
 * A rider handing in the cash they hold. One person counts it in front of a witness, against what the rider is expected to hold (all of it).
 * Exact, or short or over by no more than the company's limit, it posts at once; a bigger difference waits for a second person, and until
 * then nothing is posted and the rider still holds the cash. Posted, the cash moves from the account riders' cash is held in to the till or
 * bank counted into, any difference is written to the difference account, and the rider's custody comes to nothing (the hand-in, and the
 * difference as an adjustment with its reason). One transaction: the hand-in, the custody entries, the bank ledgers and the journal.
 */
export class DoorHandIns {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly engine: Pick<PostingEngine, 'post' | 'dateIssues'>,
    private readonly numbering: Pick<NumberSeriesService, 'assign'>,
  ) {}

  // ── Differences: the limit and the account ───────────────────────────────────────────────────────────────────────

  async differences(companyId: string): Promise<{ varianceLimit: string; varianceGlAccountId: string | null; varianceAccountName: string | null; version: number }> {
    const [row] = await this.db
      .select({ s: deliveryDoorSettings, no: glAccounts.no, name: glAccounts.name })
      .from(deliveryDoorSettings)
      .leftJoin(glAccounts, eq(glAccounts.id, deliveryDoorSettings.varianceGlAccountId))
      .where(eq(deliveryDoorSettings.companyId, companyId));
    return { varianceLimit: row?.s.varianceLimit ?? '0.00', varianceGlAccountId: row?.s.varianceGlAccountId ?? null, varianceAccountName: row?.no === undefined || row.no === null ? null : `${row.no} ${row.name ?? ''}`.trim(), version: row?.s.version ?? 0 };
  }

  /** How big a difference at a hand-in may be before a second person must approve it, and the account a difference is written to. */
  async setDifferences(actor: DocActor, input: { varianceLimit?: unknown; varianceGlAccountId?: unknown; expectedVersion?: unknown }): Promise<DocResult<Awaited<ReturnType<DoorHandIns['differences']>>>> {
    const limit = typeof input.varianceLimit === 'number' && Number.isFinite(input.varianceLimit) && input.varianceLimit >= 0 ? toCents(input.varianceLimit) : null;
    if (limit === null) return fail('bad_input', 'Say how large a difference may be before it needs approval, in shillings (nothing is allowed).');
    const glId = typeof input.varianceGlAccountId === 'string' && input.varianceGlAccountId !== '' ? input.varianceGlAccountId : null;
    const version = typeof input.expectedVersion === 'number' ? input.expectedVersion : 0;
    return await this.db.transaction(async (tx) => {
      if (glId !== null) {
        const [gl] = await tx.select({ type: glAccounts.type, blocked: glAccounts.blocked }).from(glAccounts).where(and(eq(glAccounts.id, glId), eq(glAccounts.companyId, actor.companyId)));
        if (gl === undefined) return fail('not_found', 'That account could not be found.');
        if (gl.type !== 'posting' || gl.blocked) return fail('bad_input', 'Choose an open account that can be posted to.');
      }
      await tx.insert(deliveryDoorSettings).values({ companyId: actor.companyId }).onConflictDoNothing();
      const [row] = await tx.select().from(deliveryDoorSettings).where(eq(deliveryDoorSettings.companyId, actor.companyId)).for('update');
      if (row === undefined) return fail('not_found', 'The setting could not be found.');
      if (version !== 0 && version !== row.version) return fail('conflict', 'Someone else changed this while you were looking. Reload to see their change.');
      const changed = toCents(row.varianceLimit) !== limit || row.varianceGlAccountId !== glId;
      if (changed) {
        await tx.update(deliveryDoorSettings).set({ varianceLimit: fromCents(limit), varianceGlAccountId: glId, version: row.version + 1, updatedBy: actor.userId, updatedAt: new Date() }).where(eq(deliveryDoorSettings.companyId, actor.companyId));
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'door_payments', id: actor.companyId }, action: 'door_payments.differences_set', actor: { type: 'user', id: actor.userId }, from: `${row.varianceLimit} ${row.varianceGlAccountId ?? '-'}`, to: `${fromCents(limit)} ${glId ?? '-'}` }, tx);
      }
      return { ok: true, data: await this.differencesIn(tx, actor.companyId) };
    });
  }

  private async differencesIn(tx: Tx, companyId: string) {
    const [row] = await tx.select({ s: deliveryDoorSettings, no: glAccounts.no, name: glAccounts.name }).from(deliveryDoorSettings).leftJoin(glAccounts, eq(glAccounts.id, deliveryDoorSettings.varianceGlAccountId)).where(eq(deliveryDoorSettings.companyId, companyId));
    return { varianceLimit: row?.s.varianceLimit ?? '0.00', varianceGlAccountId: row?.s.varianceGlAccountId ?? null, varianceAccountName: row?.no === undefined || row.no === null ? null : `${row.no} ${row.name ?? ''}`.trim(), version: row?.s.version ?? 0 };
  }

  // ── Recording a hand-in ──────────────────────────────────────────────────────────────────────────────────────────

  /** The account riders' cash is held in, and its books account: through the payment method chosen for cash at the door. */
  private async custodyAccount(tx: Tx, companyId: string): Promise<{ bankId: string; glId: string; currency: string; code: string } | null> {
    const [row] = await tx
      .select({ bankId: bankAccounts.id, glId: paymentMethods.glAccountId, currency: bankAccounts.currency, code: bankAccounts.code })
      .from(deliveryDoorSettings)
      .innerJoin(paymentMethods, eq(paymentMethods.id, deliveryDoorSettings.cashMethodId))
      .innerJoin(bankAccounts, eq(bankAccounts.id, paymentMethods.balancingBankAccountId))
      .where(eq(deliveryDoorSettings.companyId, companyId));
    return row ?? null;
  }

  async record(actor: DocActor, input: { riderId?: unknown; counted?: unknown; toBankAccountId?: unknown; witnessUserId?: unknown; note?: unknown }): Promise<DocResult<HandInView>> {
    if (typeof input.riderId !== 'string' || input.riderId === '') return fail('bad_input', 'Choose the rider handing in the cash.');
    if (typeof input.toBankAccountId !== 'string' || input.toBankAccountId === '') return fail('bad_input', 'Choose the till or bank account the cash goes into.');
    const riderId = input.riderId;
    const toId = input.toBankAccountId;
    const note = text(input.note, 300);
    try {
      return await this.db.transaction(async (tx): Promise<DocResult<HandInView>> => {
        const [rider] = await tx.select().from(deliveryRiders).where(and(eq(deliveryRiders.id, riderId), eq(deliveryRiders.companyId, actor.companyId))).for('update');
        if (rider === undefined) return fail('not_found', 'That rider could not be found.');
        const custody = await this.custodyAccount(tx, actor.companyId);
        if (custody === null) return fail('not_allowed', 'Cash at the door is not set up (Delivery › Door payments).');
        const [fin] = await tx.select({ base: financeSettings.baseCurrency, live: financeSettings.salesGlGoLive }).from(financeSettings).where(eq(financeSettings.companyId, actor.companyId));
        const base = fin?.base ?? 'KES';
        if (custody.currency.toUpperCase() !== base.toUpperCase()) return fail('not_allowed', `The account riders' cash is held in is in ${custody.currency}; hand-ins are taken in ${base} only.`);
        const [to] = await tx.select().from(bankAccounts).where(and(eq(bankAccounts.id, toId), eq(bankAccounts.companyId, actor.companyId)));
        if (to === undefined) return fail('not_found', 'That till or bank account could not be found.');
        if (to.blocked) return fail('not_allowed', `${to.code} is blocked.`);
        if (to.currency.toUpperCase() !== base.toUpperCase()) return fail('not_allowed', `${to.code} is in ${to.currency}; hand-ins go into ${base} accounts.`);
        const toGl = await this.glOf(tx, actor.companyId, to.id);
        if (toGl === null) return fail('not_allowed', `${to.code} has no payment method, so there is no books account to put the cash in. Add one under Settings › Payments.`);
        if (typeof input.witnessUserId !== 'string' || input.witnessUserId === '') return fail('bad_input', 'A second person must witness the count. Choose who.');
        const [witness] = UUID.test(input.witnessUserId) ? await tx.select({ id: users.id, name: users.name, active: users.isActive, status: users.status }).from(users).where(eq(users.id, input.witnessUserId)) : [];
        if (witness === undefined || !witness.active || witness.status !== 'active') return fail('not_found', 'That witness could not be found.');
        const [pending] = await tx.select({ id: cashHandIns.id }).from(cashHandIns).where(and(eq(cashHandIns.riderId, riderId), eq(cashHandIns.status, 'pending_approval')));
        if (pending !== undefined) return fail('conflict', 'This rider already has a hand-in waiting for approval. Approve or refuse it first.');

        const held = await this.heldCents(tx, actor.companyId, riderId);
        const diff = await this.differencesIn(tx, actor.companyId);
        const checked = handInProblem(
          { expectedCents: held, counted: input.counted, note, hasVarianceAccount: diff.varianceGlAccountId !== null, recorderId: actor.userId, witnessId: witness.id, riderUserId: rider.userId, sameAccount: to.id === custody.bankId },
          toCents(diff.varianceLimit),
        );
        if ('error' in checked) return fail('bad_input', checked.error);
        const id = crypto.randomUUID();
        const { number } = await this.numbering.assign('cash_hand_in', { companyId: actor.companyId, date: businessDate(), document: { kind: 'cash_hand_in', id } }, tx);
        const needs = checked.check.kind === 'needs_approval';
        await tx.insert(cashHandIns).values({
          id,
          companyId: actor.companyId,
          number,
          riderId,
          // Always made waiting; one that needs no approval is posted straight away, in this transaction, which is its only decision.
          status: 'pending_approval',
          expectedAmount: fromCents(checked.check.expectedCents),
          countedAmount: fromCents(checked.countedCents),
          difference: fromCents(checked.check.diffCents),
          currency: custody.currency,
          custodyBankAccountId: custody.bankId,
          toBankAccountId: to.id,
          varianceGlAccountId: checked.check.diffCents === 0 ? null : diff.varianceGlAccountId,
          witnessUserId: witness.id,
          witnessName: witness.name,
          note,
          countedBy: actor.userId,
          decidedAt: null,
          approvedBy: null,
        });
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'cash_hand_in', id }, action: needs ? 'door_payments.hand_in_waiting' : 'door_payments.hand_in_recorded', actor: { type: 'user', id: actor.userId }, outcome: { number, expected: fromCents(checked.check.expectedCents), counted: fromCents(checked.countedCents), difference: fromCents(checked.check.diffCents), witness: witness.name } }, tx);
        if (!needs) await this.postIn(tx, actor, id, null);
        return { ok: true, data: await this.viewIn(tx, actor.companyId, id) };
      });
    } catch (error) {
      if (error instanceof FinanceError) return fail('not_allowed', error.message);
      throw error;
    }
  }

  /** The books account of a till or bank account: the one its payment methods post to (several is a choice the books make, not this screen). */
  private async glOf(tx: Tx, companyId: string, bankAccountId: string): Promise<string | null> {
    const rows = await tx.select({ gl: paymentMethods.glAccountId }).from(paymentMethods).where(and(eq(paymentMethods.companyId, companyId), eq(paymentMethods.balancingBankAccountId, bankAccountId)));
    const distinct = [...new Set(rows.map((r) => r.gl))];
    return distinct.length === 1 ? (distinct[0] ?? null) : null;
  }

  private async heldCents(tx: Tx | DrizzleDb, companyId: string, riderId: string): Promise<number> {
    const rows = await tx.select({ kind: cashCustodyEntries.kind, amount: cashCustodyEntries.amount }).from(cashCustodyEntries).where(and(eq(cashCustodyEntries.companyId, companyId), eq(cashCustodyEntries.riderId, riderId)));
    return custodyBalance(rows.map((r) => ({ kind: r.kind, cents: toCents(r.amount) })));
  }

  /**
   * Posts a hand-in (in the caller's transaction): the custody entries, both bank ledgers and, once the books are live, the journal. For a
   * hand-in that waited, what the rider holds must still be what was counted against, or it is refused and recorded again.
   */
  private async postIn(tx: Tx, actor: DocActor, id: string, approver: string | null): Promise<void> {
    const [h] = await tx.select().from(cashHandIns).where(eq(cashHandIns.id, id)).for('update');
    if (h === undefined) throw new FinanceError('NOT_FOUND', 'That hand-in could not be found.');
    const held = await this.heldCents(tx, h.companyId, h.riderId);
    if (held !== toCents(h.expectedAmount)) throw new FinanceError('BALANCE_CHANGED', `The rider now holds KSh ${fromCents(held)}, not the KSh ${h.expectedAmount} this was counted against. Refuse it and count again.`);
    const check = handInCheck(toCents(h.expectedAmount), toCents(h.countedAmount), 0);
    const date = businessDate();
    const issues = await this.engine.dateIssues(tx, h.companyId, date, NO_SPECIAL_PERMISSIONS);
    if (issues.length > 0) throw new FinanceError(issues[0]?.code ?? 'DATE', issues.map((i) => i.message).join(' '));
    const [fin] = await tx.select({ live: financeSettings.salesGlGoLive, base: financeSettings.baseCurrency }).from(financeSettings).where(eq(financeSettings.companyId, h.companyId));
    const custody = await this.custodyAccount(tx, h.companyId);
    const toGl = await this.glOf(tx, h.companyId, h.toBankAccountId);
    if (custody === null || toGl === null) throw new FinanceError('NOT_SET_UP', 'The accounts for this hand-in are no longer set up.');
    const glOf = { destination: toGl, custody: custody.glId, variance: h.varianceGlAccountId };
    const bankOf = { destination: h.toBankAccountId, custody: h.custodyBankAccountId, variance: null };
    let registerId: string | null = null;
    if (fin?.live != null && date >= fin.live) {
      const lines = handInLines(check).map((l) => {
        const accountId = glOf[l.account];
        if (accountId === null) throw new FinanceError('NO_VARIANCE_ACCOUNT', 'Choose the account a difference is written to (Door payments › Differences).');
        const bank = bankOf[l.account];
        return {
          accountId,
          debit: l.side === 'debit' ? fromCents(l.cents) : '0',
          credit: l.side === 'credit' ? fromCents(l.cents) : '0',
          description: l.account === 'variance' ? (h.note ?? `Difference at ${h.number}`).slice(0, 200) : `Cash handed in ${h.number}`,
          ...(bank === null ? {} : { sourceLedger: 'bank' as const, sourceEntryId: bank }),
        };
      });
      const req: PostingRequest = {
        companyId: h.companyId,
        idempotencyKey: `cash_hand_in:${h.id}`,
        postingDate: date,
        documentType: 'cash_hand_in',
        documentNo: h.number,
        description: `Rider cash handed in ${h.number}`.slice(0, 200),
        currency: fin.base,
        rate: '1',
        rateSource: 'base',
        lines,
        chainKey: 'general',
        origin: { surface: 'delivery/door-payments', action: 'hand_in' },
        source: { type: 'cash_hand_in', id: h.id },
        postedBy: 'engine',
      };
      registerId = (await this.engine.post(req, NO_SPECIAL_PERMISSIONS, tx)).registerId;
    }
    // The bank ledgers move whether or not the books are live: what leaves the riders' cash account, and what the till or bank takes.
    await tx.insert(bankLedgerEntries).values([
      { companyId: h.companyId, bankAccountId: h.custodyBankAccountId, glAccountId: custody.glId, postingDate: date, documentType: 'cash_hand_in', documentNo: h.number, documentId: h.id, description: `Handed in by rider, ${h.number}`, amount: fromCents(-toCents(h.expectedAmount)), currency: h.currency, registerId, createdBy: actor.userId },
      { companyId: h.companyId, bankAccountId: h.toBankAccountId, glAccountId: toGl, postingDate: date, documentType: 'cash_hand_in', documentNo: h.number, documentId: h.id, description: `Cash handed in by rider, ${h.number}`, amount: h.countedAmount, currency: h.currency, registerId, createdBy: actor.userId },
    ]);
    for (const w of custodyWrites(check, h.note)) {
      await tx.insert(cashCustodyEntries).values({ companyId: h.companyId, riderId: h.riderId, kind: w.kind, amount: fromCents(w.cents), currency: h.currency, key: `${w.kind}:${h.id}`, note: w.note, handInId: h.id, actorId: actor.userId });
    }
    await tx.update(cashHandIns).set({ status: 'posted', registerId, approvedBy: approver, decidedAt: new Date() }).where(eq(cashHandIns.id, h.id));
  }

  // ── A second person decides ──────────────────────────────────────────────────────────────────────────────────────

  async approve(actor: DocActor, id: string): Promise<DocResult<HandInView>> {
    try {
      return await this.db.transaction(async (tx): Promise<DocResult<HandInView>> => {
        const [h] = await tx.select().from(cashHandIns).where(and(eq(cashHandIns.id, id), eq(cashHandIns.companyId, actor.companyId))).for('update');
        if (h === undefined) return fail('not_found', 'That hand-in could not be found.');
        if (h.status !== 'pending_approval') return fail('not_allowed', 'This hand-in has already been decided.');
        const problem = approverProblem(actor.userId, h.countedBy);
        if (problem !== null) return fail('not_allowed', problem);
        await tx.select({ id: deliveryRiders.id }).from(deliveryRiders).where(eq(deliveryRiders.id, h.riderId)).for('update');
        await this.postIn(tx, actor, id, actor.userId);
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'cash_hand_in', id }, action: 'door_payments.hand_in_approved', actor: { type: 'user', id: actor.userId }, from: 'pending_approval', to: 'posted', outcome: { number: h.number, difference: h.difference } }, tx);
        return { ok: true, data: await this.viewIn(tx, actor.companyId, id) };
      });
    } catch (error) {
      if (error instanceof FinanceError) return fail('conflict', error.message);
      throw error;
    }
  }

  async reject(actor: DocActor, id: string, input: { reason?: unknown }): Promise<DocResult<HandInView>> {
    const reason = text(input.reason, 300);
    if (reason === null || reason.length < 5) return fail('bad_input', 'Say why the hand-in is not accepted, in a few words.');
    return await this.db.transaction(async (tx): Promise<DocResult<HandInView>> => {
      const [h] = await tx.select().from(cashHandIns).where(and(eq(cashHandIns.id, id), eq(cashHandIns.companyId, actor.companyId))).for('update');
      if (h === undefined) return fail('not_found', 'That hand-in could not be found.');
      if (h.status !== 'pending_approval') return fail('not_allowed', 'This hand-in has already been decided.');
      await tx.update(cashHandIns).set({ status: 'rejected', approvedBy: actor.userId, decisionReason: reason, decidedAt: new Date() }).where(eq(cashHandIns.id, id));
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'cash_hand_in', id }, action: 'door_payments.hand_in_refused', actor: { type: 'user', id: actor.userId }, from: 'pending_approval', to: 'rejected', reason: { text: reason } }, tx);
      return { ok: true, data: await this.viewIn(tx, actor.companyId, id) };
    });
  }

  // ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────────

  private view(row: CashHandInRow, riderName: string, toAccount: string): HandInView {
    return {
      id: row.id,
      number: row.number,
      riderId: row.riderId,
      riderName,
      status: row.status,
      statusWords: HAND_IN_WORDS[row.status],
      expected: row.expectedAmount,
      counted: row.countedAmount,
      difference: row.difference,
      currency: row.currency,
      toAccount,
      witnessName: row.witnessName,
      note: row.note,
      countedBy: row.countedBy,
      approvedBy: row.approvedBy,
      decisionReason: row.decisionReason,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
    };
  }

  private async viewIn(db: Tx | DrizzleDb, companyId: string, id: string): Promise<HandInView> {
    const [r] = await db
      .select({ h: cashHandIns, riderName: deliveryRiders.name, toCode: bankAccounts.code, toName: bankAccounts.name })
      .from(cashHandIns)
      .innerJoin(deliveryRiders, eq(deliveryRiders.id, cashHandIns.riderId))
      .innerJoin(bankAccounts, eq(bankAccounts.id, cashHandIns.toBankAccountId))
      .where(and(eq(cashHandIns.id, id), eq(cashHandIns.companyId, companyId)));
    if (r === undefined) throw new Error(`The hand-in ${id} vanished.`);
    return this.view(r.h, r.riderName, `${r.toCode} · ${r.toName}`);
  }

  /** Hand-ins, newest first, one page at a time; the ones waiting for approval can be asked for alone. */
  async list(companyId: string, input: { status?: unknown; riderId?: unknown; cursor?: unknown }): Promise<{ rows: HandInView[]; nextCursor: string | null }> {
    const after = typeof input.cursor === 'string' && input.cursor !== '' ? decodeCursor(input.cursor) : null;
    const status = typeof input.status === 'string' && (['pending_approval', 'posted', 'rejected'] as string[]).includes(input.status) ? (input.status as HandInStatus) : null;
    const riderId = typeof input.riderId === 'string' && input.riderId !== '' ? input.riderId : null;
    const rows = await this.db
      .select({ h: cashHandIns, cursorKey: sql<string>`${cashHandIns.createdAt}::text`, riderName: deliveryRiders.name, toCode: bankAccounts.code, toName: bankAccounts.name })
      .from(cashHandIns)
      .innerJoin(deliveryRiders, eq(deliveryRiders.id, cashHandIns.riderId))
      .innerJoin(bankAccounts, eq(bankAccounts.id, cashHandIns.toBankAccountId))
      .where(
        and(
          eq(cashHandIns.companyId, companyId),
          status === null ? undefined : eq(cashHandIns.status, status),
          riderId === null ? undefined : eq(cashHandIns.riderId, riderId),
          after === null ? undefined : sql`(${cashHandIns.createdAt}, ${cashHandIns.id}) < (${after.k}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(cashHandIns.createdAt), desc(cashHandIns.id))
      .limit(PAGE + 1);
    const page = rows.slice(0, PAGE);
    const last = page[page.length - 1];
    return { rows: page.map((r) => this.view(r.h, r.riderName, `${r.toCode} · ${r.toName}`)), nextCursor: rows.length > PAGE && last !== undefined ? encodeCursor({ k: last.cursorKey, id: last.h.id }) : null };
  }

  /** How many are waiting for a second person, for the badge on the screen. */
  async waiting(companyId: string): Promise<number> {
    const [r] = await this.db.select({ n: sql<number>`count(*)::int` }).from(cashHandIns).where(and(eq(cashHandIns.companyId, companyId), eq(cashHandIns.status, 'pending_approval')));
    return r?.n ?? 0;
  }

  /** Riders with cash to hand in and nothing waiting, for choosing who is handing in. */
  async ridersWithCash(companyId: string): Promise<{ riderId: string; name: string; held: string }[]> {
    const rows = await this.db.select({ riderId: cashCustodyEntries.riderId, kind: cashCustodyEntries.kind, amount: cashCustodyEntries.amount }).from(cashCustodyEntries).where(eq(cashCustodyEntries.companyId, companyId));
    const ids = [...new Set(rows.map((r) => r.riderId))];
    if (ids.length === 0) return [];
    const names = await this.db.select({ id: deliveryRiders.id, name: deliveryRiders.name }).from(deliveryRiders).where(inArray(deliveryRiders.id, ids));
    return ids
      .map((riderId) => ({ riderId, name: names.find((n) => n.id === riderId)?.name ?? 'Rider', cents: custodyBalance(rows.filter((r) => r.riderId === riderId).map((r) => ({ kind: r.kind, cents: toCents(r.amount) }))) }))
      .filter((r) => r.cents > 0)
      .sort((a, b) => firstNonZero(b.cents - a.cents, a.name.localeCompare(b.name)))
      .map((r) => ({ riderId: r.riderId, name: r.name, held: fromCents(r.cents) }));
  }
}
