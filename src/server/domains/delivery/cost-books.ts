import { and, asc, desc, eq, inArray, notExists, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { bankAccounts, bankLedgerEntries, deliveryCostPostings, deliveryCosts, deliveryPayPayoutItems, deliveryPayPayouts, deliveryPaySettings, deliveryRiders, financeSettings, glAccounts, paymentMethods } from '@/server/db/drizzle/schema';
import { PAYS_RIDERS, costPostingLines, isPayoutMethodKind, money, payoutPostingLines, payoutProblem, retryAfterSeconds } from '@/lib/delivery-cost';
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PAGE = 25;
const cents = (amount: string): number => Math.round(Number(amount) * 100);

export interface AccountsView {
  expenseGlAccountId: string | null;
  expenseName: string | null;
  payableGlAccountId: string | null;
  payableName: string | null;
  version: number;
}

export interface OwedView {
  riderId: string;
  name: string;
  status: string;
  /** What is owed to the rider now (earned pay less anything taken back, not yet paid out), as exact money. */
  owed: string;
  entries: number;
}

export interface PayoutView {
  id: string;
  number: string;
  riderId: string;
  riderName: string;
  amount: string;
  currency: string;
  method: string;
  paidOn: string;
  reference: string | null;
  note: string | null;
  paidBy: string;
  createdAt: string;
}

/**
 * Rider pay in the books. Pay earned is saved first (see DeliveryCosts) and posted afterwards from a queue, retrying with a growing
 * delay: a cost owed to the rider (debit the cost account, credit what is owed to riders). A payout then pays everything owed to a rider at
 * the time (earned pay less anything taken back), moving it from what is owed to the till or bank of the payment method chosen. Nothing is
 * posted before the books are live, and nothing without both accounts chosen. A cost is paid out once.
 */
export class DeliveryCostBooks {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly engine: Pick<PostingEngine, 'post' | 'dateIssues'>,
    private readonly numbering: Pick<NumberSeriesService, 'assign'>,
  ) {}

  // ── The accounts ─────────────────────────────────────────────────────────────────────────────────────────────────

  async accounts(companyId: string): Promise<AccountsView> {
    const [row] = await this.db.select().from(deliveryPaySettings).where(eq(deliveryPaySettings.companyId, companyId));
    const ids = [row?.expenseGlAccountId, row?.payableGlAccountId].filter((x): x is string => typeof x === 'string');
    const names = ids.length === 0 ? [] : await this.db.select({ id: glAccounts.id, no: glAccounts.no, name: glAccounts.name }).from(glAccounts).where(inArray(glAccounts.id, ids));
    const nameOf = (id: string | null | undefined): string | null => {
      const n = names.find((x) => x.id === id);
      return n === undefined ? null : `${n.no} ${n.name}`;
    };
    return { expenseGlAccountId: row?.expenseGlAccountId ?? null, expenseName: nameOf(row?.expenseGlAccountId), payableGlAccountId: row?.payableGlAccountId ?? null, payableName: nameOf(row?.payableGlAccountId), version: row?.version ?? 0 };
  }

  /** The cost account and the account that holds what is owed to riders. Two different open accounts that take postings. */
  async setAccounts(actor: DocActor, input: { expenseGlAccountId?: unknown; payableGlAccountId?: unknown; expectedVersion?: unknown }): Promise<DocResult<AccountsView>> {
    const expense = typeof input.expenseGlAccountId === 'string' && UUID.test(input.expenseGlAccountId) ? input.expenseGlAccountId : null;
    const payable = typeof input.payableGlAccountId === 'string' && UUID.test(input.payableGlAccountId) ? input.payableGlAccountId : null;
    if (expense === null || payable === null) return fail('bad_input', 'Choose the account rider pay is booked to, and the account that holds what is owed to riders.');
    if (expense === payable) return fail('bad_input', 'These must be two different accounts.');
    const version = typeof input.expectedVersion === 'number' ? input.expectedVersion : 0;
    const done = await this.db.transaction(async (tx): Promise<DocResult<null>> => {
      const found = await tx.select({ id: glAccounts.id, type: glAccounts.type, blocked: glAccounts.blocked }).from(glAccounts).where(and(eq(glAccounts.companyId, actor.companyId), inArray(glAccounts.id, [expense, payable])));
      if (found.length !== 2) return fail('not_found', 'One of those accounts could not be found.');
      if (found.some((a) => a.type !== 'posting' || a.blocked)) return fail('bad_input', 'Choose open accounts that can be posted to.');
      await tx.insert(deliveryPaySettings).values({ companyId: actor.companyId }).onConflictDoNothing();
      const [row] = await tx.select().from(deliveryPaySettings).where(eq(deliveryPaySettings.companyId, actor.companyId)).for('update');
      if (row === undefined) return fail('not_found', 'The setting could not be found.');
      if (version !== 0 && version !== row.version) return fail('conflict', 'Someone else changed this while you were looking. Reload to see their change.');
      if (row.expenseGlAccountId !== expense || row.payableGlAccountId !== payable) {
        await tx.update(deliveryPaySettings).set({ expenseGlAccountId: expense, payableGlAccountId: payable, version: row.version + 1, updatedBy: actor.userId, updatedAt: new Date() }).where(eq(deliveryPaySettings.companyId, actor.companyId));
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery_pay', id: actor.companyId }, action: 'delivery_pay.accounts_set', actor: { type: 'user', id: actor.userId }, from: `${row.expenseGlAccountId ?? '-'}/${row.payableGlAccountId ?? '-'}`, to: `${expense}/${payable}` }, tx);
      }
      return { ok: true, data: null };
    });
    return done.ok ? { ok: true, data: await this.accounts(actor.companyId) } : done;
  }

  // ── Posting what was earned ──────────────────────────────────────────────────────────────────────────────────────

  /** Whether rider pay can be posted now: both accounts chosen and the books live. */
  private async ready(tx: Tx | DrizzleDb, companyId: string): Promise<{ expense: string; payable: string; base: string } | null> {
    const [s] = await tx.select().from(deliveryPaySettings).where(eq(deliveryPaySettings.companyId, companyId));
    const [fin] = await tx.select({ live: financeSettings.salesGlGoLive, base: financeSettings.baseCurrency }).from(financeSettings).where(eq(financeSettings.companyId, companyId));
    if (s?.expenseGlAccountId == null || s.payableGlAccountId == null || fin?.live == null || businessDate() < fin.live) return null;
    return { expense: s.expenseGlAccountId, payable: s.payableGlAccountId, base: fin.base };
  }

  /** Posts one cost in the caller's transaction, once. False when it cannot be posted yet (no accounts, books not live). */
  private async postIn(tx: Tx, costId: string): Promise<boolean> {
    const [cost] = await tx.select().from(deliveryCosts).where(eq(deliveryCosts.id, costId)).for('update');
    if (cost === undefined || !PAYS_RIDERS.includes(cost.kind)) return true;
    const [done] = await tx.select({ status: deliveryCostPostings.status }).from(deliveryCostPostings).where(eq(deliveryCostPostings.costId, costId));
    if (done?.status === 'posted') return true;
    const ready = await this.ready(tx, cost.companyId);
    if (ready === null) return false;
    const date = businessDate();
    const issues = await this.engine.dateIssues(tx, cost.companyId, date, NO_SPECIAL_PERMISSIONS);
    if (issues.length > 0) throw new FinanceError(issues[0]?.code ?? 'DATE', issues.map((i) => i.message).join(' '));
    const accountOf = { expense: ready.expense, payable: ready.payable };
    const req: PostingRequest = {
      companyId: cost.companyId,
      idempotencyKey: `delivery_cost:${cost.id}`,
      postingDate: date,
      documentType: 'delivery_cost',
      documentNo: cost.key.slice(0, 60),
      description: `${cost.kind === 'rider_day' ? 'Rider day pay' : 'Rider delivery pay'}${cost.note === null ? '' : `: ${cost.note}`}`.slice(0, 200),
      currency: ready.base,
      rate: '1',
      rateSource: 'base',
      lines: costPostingLines(cents(cost.amount)).map((l) => ({ accountId: accountOf[l.account], debit: l.side === 'debit' ? money(l.cents) : '0', credit: l.side === 'credit' ? money(l.cents) : '0', description: `Pay for rider ${cost.riderId ?? ''}`.slice(0, 200) })),
      chainKey: 'general',
      origin: { surface: 'delivery/costs', action: 'post_rider_pay' },
      source: { type: 'delivery_cost', id: cost.id },
      postedBy: 'engine',
    };
    const registerId = (await this.engine.post(req, NO_SPECIAL_PERMISSIONS, tx)).registerId;
    await tx
      .insert(deliveryCostPostings)
      .values({ costId: cost.id, companyId: cost.companyId, status: 'posted', registerId, attempts: (done === undefined ? 0 : 1), postedAt: new Date() })
      .onConflictDoUpdate({ target: deliveryCostPostings.costId, set: { status: 'posted', registerId, postedAt: new Date(), lastError: null } });
    return true;
  }

  /** Posts what is due, oldest first, retrying the ones that failed. Safe to run from several workers at once. */
  async processDue(limit = 100): Promise<{ posted: number; failed: number; waiting: number }> {
    const due = await this.db
      .select({ id: deliveryCosts.id, companyId: deliveryCosts.companyId })
      .from(deliveryCosts)
      .leftJoin(deliveryCostPostings, eq(deliveryCostPostings.costId, deliveryCosts.id))
      .where(and(inArray(deliveryCosts.kind, [...PAYS_RIDERS]), sql`(${deliveryCostPostings.costId} IS NULL OR (${deliveryCostPostings.status} = 'failed' AND ${deliveryCostPostings.nextAttemptAt} <= now()))`))
      .orderBy(asc(deliveryCosts.createdAt))
      .limit(limit);
    const out = { posted: 0, failed: 0, waiting: 0 };
    for (const { id, companyId } of due) {
      if ((await this.ready(this.db, companyId)) === null) {
        out.waiting += 1;
        continue;
      }
      try {
        const posted = await this.db.transaction(async (tx) => await this.postIn(tx, id));
        if (posted) out.posted += 1;
        else out.waiting += 1;
      } catch (error) {
        out.failed += 1;
        const message = error instanceof Error ? error.message.slice(0, 500) : 'unknown';
        const [prev] = await this.db.select({ attempts: deliveryCostPostings.attempts }).from(deliveryCostPostings).where(eq(deliveryCostPostings.costId, id));
        const attempts = (prev?.attempts ?? 0) + 1;
        await this.db
          .insert(deliveryCostPostings)
          .values({ costId: id, companyId, status: 'failed', attempts, lastError: message, nextAttemptAt: new Date(Date.now() + retryAfterSeconds(attempts) * 1000) })
          .onConflictDoUpdate({ target: deliveryCostPostings.costId, set: { attempts, lastError: message, nextAttemptAt: new Date(Date.now() + retryAfterSeconds(attempts) * 1000) } });
      }
    }
    return out;
  }

  // ── What is owed, and paying it ──────────────────────────────────────────────────────────────────────────────────

  /** Costs not yet in a payout: what is owed to each rider. */
  async owed(companyId: string): Promise<OwedView[]> {
    const rows = await this.db
      .select({ riderId: deliveryCosts.riderId, amount: deliveryCosts.amount })
      .from(deliveryCosts)
      .where(and(eq(deliveryCosts.companyId, companyId), inArray(deliveryCosts.kind, [...PAYS_RIDERS]), notExists(this.db.select({ x: sql`1` }).from(deliveryPayPayoutItems).where(eq(deliveryPayPayoutItems.costId, deliveryCosts.id)))));
    const ids = [...new Set(rows.flatMap((r) => (r.riderId === null ? [] : [r.riderId])))];
    if (ids.length === 0) return [];
    const riders = await this.db.select({ id: deliveryRiders.id, name: deliveryRiders.name, status: deliveryRiders.status }).from(deliveryRiders).where(inArray(deliveryRiders.id, ids));
    return ids
      .map((riderId) => {
        const mine = rows.filter((r) => r.riderId === riderId);
        const r = riders.find((x) => x.id === riderId);
        return { riderId, name: r?.name ?? 'Rider', status: r?.status ?? 'ended', cents: mine.reduce((n, x) => n + cents(x.amount), 0), entries: mine.length };
      })
      .sort((a, b) => firstNonZero(b.cents - a.cents, a.name.localeCompare(b.name)))
      .map((x) => ({ riderId: x.riderId, name: x.name, status: x.status, owed: money(x.cents), entries: x.entries }));
  }

  /**
   * Pays a rider everything owed to them. One transaction: any entry not yet in the books is posted first, the payout takes in each
   * entry (so none is paid twice), the till or bank of the method chosen pays it, and, once the books are live, what was owed is cleared.
   */
  async pay(actor: DocActor, input: { riderId?: unknown; paymentMethodId?: unknown; reference?: unknown; note?: unknown; paidOn?: unknown }): Promise<DocResult<PayoutView>> {
    if (typeof input.riderId !== 'string' || !UUID.test(input.riderId)) return fail('bad_input', 'Choose the rider to pay.');
    if (typeof input.paymentMethodId !== 'string' || !UUID.test(input.paymentMethodId)) return fail('bad_input', 'Choose how the rider is paid (cash, M-Pesa or bank).');
    const riderId = input.riderId;
    const methodId = input.paymentMethodId;
    const today = businessDate();
    const paidOn = typeof input.paidOn === 'string' && DATE.test(input.paidOn) ? input.paidOn : today;
    if (paidOn > today) return fail('bad_input', 'Pay cannot be recorded on a day that has not come.');
    try {
      return await this.db.transaction(async (tx): Promise<DocResult<PayoutView>> => {
        const [rider] = await tx.select().from(deliveryRiders).where(and(eq(deliveryRiders.id, riderId), eq(deliveryRiders.companyId, actor.companyId))).for('update');
        if (rider === undefined) return fail('not_found', 'That rider could not be found.');
        const [method] = await tx.select({ id: paymentMethods.id, name: paymentMethods.name, kind: paymentMethods.kind, enabled: paymentMethods.enabled, bank: paymentMethods.balancingBankAccountId, gl: paymentMethods.glAccountId }).from(paymentMethods).where(and(eq(paymentMethods.id, methodId), eq(paymentMethods.companyId, actor.companyId)));
        if (method === undefined) return fail('not_found', 'That payment method could not be found.');
        if (!method.enabled || !isPayoutMethodKind(method.kind)) return fail('bad_input', 'Choose a payment method that is switched on and pays in cash, M-Pesa or through the bank.');
        const [bank] = await tx.select({ code: bankAccounts.code, currency: bankAccounts.currency, blocked: bankAccounts.blocked }).from(bankAccounts).where(eq(bankAccounts.id, method.bank));
        const [fin] = await tx.select({ base: financeSettings.baseCurrency }).from(financeSettings).where(eq(financeSettings.companyId, actor.companyId));
        const base = fin?.base ?? 'KES';
        if (bank === undefined || bank.blocked) return fail('not_allowed', 'The account that method pays from is not available.');
        if (bank.currency.toUpperCase() !== base.toUpperCase()) return fail('not_allowed', `Pay is in ${base}; that method pays from a ${bank.currency} account.`);

        const entries = await tx
          .select()
          .from(deliveryCosts)
          .where(and(eq(deliveryCosts.companyId, actor.companyId), eq(deliveryCosts.riderId, riderId), inArray(deliveryCosts.kind, [...PAYS_RIDERS]), notExists(tx.select({ x: sql`1` }).from(deliveryPayPayoutItems).where(eq(deliveryPayPayoutItems.costId, deliveryCosts.id)))))
          .orderBy(asc(deliveryCosts.createdAt));
        const owed = entries.reduce((n, e) => n + cents(e.amount), 0);
        const problem = payoutProblem(owed, entries.length);
        if (problem !== null) return fail('not_allowed', problem);

        const live = (await this.ready(tx, actor.companyId)) !== null;
        const settings = await this.accounts(actor.companyId);
        if (!live) {
          const [s] = await tx.select({ live: financeSettings.salesGlGoLive }).from(financeSettings).where(eq(financeSettings.companyId, actor.companyId));
          // The books are live but the accounts are not chosen: refuse, rather than pay out what was never booked.
          if (s?.live != null && today >= s.live && (settings.expenseGlAccountId === null || settings.payableGlAccountId === null)) return fail('not_allowed', 'Choose the accounts rider pay is booked to first (Delivery › Delivery costs › In the books).');
        }
        if (live) for (const e of entries) await this.postIn(tx, e.id);

        const id = crypto.randomUUID();
        const { number } = await this.numbering.assign('rider_payout', { companyId: actor.companyId, date: today, document: { kind: 'rider_payout', id } }, tx);
        let registerId: string | null = null;
        if (live && settings.payableGlAccountId !== null) {
          const issues = await this.engine.dateIssues(tx, actor.companyId, paidOn, NO_SPECIAL_PERMISSIONS);
          if (issues.length > 0) return fail('not_allowed', issues.map((i) => i.message).join(' '));
          const accountOf = { payable: settings.payableGlAccountId, bank: method.gl };
          const req: PostingRequest = {
            companyId: actor.companyId,
            idempotencyKey: `rider_payout:${id}`,
            postingDate: paidOn,
            documentType: 'rider_payout',
            documentNo: number,
            description: `Rider pay ${number}: ${rider.name}`.slice(0, 200),
            currency: base,
            rate: '1',
            rateSource: 'base',
            lines: payoutPostingLines(owed).map((l) => ({ accountId: accountOf[l.account], debit: l.side === 'debit' ? money(l.cents) : '0', credit: l.side === 'credit' ? money(l.cents) : '0', description: `Pay to ${rider.name}`.slice(0, 200), ...(l.account === 'bank' ? { sourceLedger: 'bank' as const, sourceEntryId: method.bank } : {}) })),
            chainKey: 'general',
            origin: { surface: 'delivery/costs', action: 'pay_rider' },
            source: { type: 'rider_payout', id },
            postedBy: 'engine',
          };
          registerId = (await this.engine.post(req, NO_SPECIAL_PERMISSIONS, tx)).registerId;
        }
        const reference = text(input.reference, 100);
        const note = text(input.note, 300);
        await tx.insert(deliveryPayPayouts).values({ id, companyId: actor.companyId, number, riderId, amount: money(owed), currency: base, paymentMethodId: method.id, bankAccountId: method.bank, paidOn, reference, note, paidBy: actor.userId, registerId });
        await tx.insert(deliveryPayPayoutItems).values(entries.map((e) => ({ payoutId: id, costId: e.id })));
        await tx.insert(bankLedgerEntries).values({ companyId: actor.companyId, bankAccountId: method.bank, glAccountId: method.gl, postingDate: paidOn, documentType: 'rider_payout', documentNo: number, documentId: id, description: `Rider pay ${number}: ${rider.name}`.slice(0, 300), amount: money(-owed), currency: base, registerId, createdBy: actor.userId });
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'rider_payout', id }, action: 'delivery_pay.paid', actor: { type: 'user', id: actor.userId }, outcome: { number, rider: rider.name, amount: money(owed), entries: entries.length, method: method.name, reference } }, tx);
        const [row] = await tx.select().from(deliveryPayPayouts).where(eq(deliveryPayPayouts.id, id));
        if (row === undefined) throw new Error('The payout vanished.');
        return { ok: true, data: this.view(row, rider.name, method.name) };
      });
    } catch (error) {
      if (error instanceof FinanceError) return fail('not_allowed', error.message);
      throw error;
    }
  }

  private view(r: typeof deliveryPayPayouts.$inferSelect, riderName: string, method: string): PayoutView {
    return { id: r.id, number: r.number, riderId: r.riderId, riderName, amount: r.amount, currency: r.currency, method, paidOn: r.paidOn, reference: r.reference, note: r.note, paidBy: r.paidBy, createdAt: r.createdAt.toISOString() };
  }

  /** Payouts, newest first, one page at a time. */
  async payouts(companyId: string, input: { riderId?: unknown; cursor?: unknown }): Promise<{ rows: PayoutView[]; nextCursor: string | null }> {
    const riderId = typeof input.riderId === 'string' && UUID.test(input.riderId) ? input.riderId : null;
    const after = typeof input.cursor === 'string' && input.cursor !== '' ? decodeCursor(input.cursor) : null;
    const rows = await this.db
      .select({ p: deliveryPayPayouts, cursorKey: sql<string>`${deliveryPayPayouts.createdAt}::text`, riderName: deliveryRiders.name, method: paymentMethods.name })
      .from(deliveryPayPayouts)
      .innerJoin(deliveryRiders, eq(deliveryRiders.id, deliveryPayPayouts.riderId))
      .innerJoin(paymentMethods, eq(paymentMethods.id, deliveryPayPayouts.paymentMethodId))
      .where(and(eq(deliveryPayPayouts.companyId, companyId), riderId === null ? undefined : eq(deliveryPayPayouts.riderId, riderId), after === null ? undefined : sql`(${deliveryPayPayouts.createdAt}, ${deliveryPayPayouts.id}) < (${after.k}::timestamptz, ${after.id}::uuid)`))
      .orderBy(desc(deliveryPayPayouts.createdAt), desc(deliveryPayPayouts.id))
      .limit(PAGE + 1);
    const page = rows.slice(0, PAGE);
    const last = page[page.length - 1];
    return { rows: page.map((r) => this.view(r.p, r.riderName, r.method)), nextCursor: rows.length > PAGE && last !== undefined ? encodeCursor({ k: last.cursorKey, id: last.p.id }) : null };
  }

  /** How many costs are not in the books yet, for the screen's note. */
  async unposted(companyId: string): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(deliveryCosts)
      .leftJoin(deliveryCostPostings, eq(deliveryCostPostings.costId, deliveryCosts.id))
      .where(and(eq(deliveryCosts.companyId, companyId), inArray(deliveryCosts.kind, [...PAYS_RIDERS]), sql`(${deliveryCostPostings.costId} IS NULL OR ${deliveryCostPostings.status} <> 'posted')`));
    return r?.n ?? 0;
  }
}
