import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  creditNoteAccounting,
  creditNoteResolutions,
  creditNotes,
  customerLedgerEntries,
  customers,
  financeSettings,
  orders,
  type CreditNoteRow,
} from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { creditNoteLines, planCredit, splitCredit } from '../domain/credit-note-accounting';
import { fromCents, toCents, type PlannedApplication } from '../domain/receivables';
import type { PostingRequest } from '../domain/types';
import type { PostingEngine, Tx } from '../engine';
import { FinanceError, type FinanceContext } from '../errors';
import type { PostingSetupService } from '../posting-setup-service';
import type { CreditPolicyService } from './credit-policy-service';
import type { CustomerLedgerService } from './customer-ledger-service';
import type { WalletService } from './wallet-service';

/**
 * What a credit note does to the customer's account and the books. It is recorded in the same
 * transaction as the credit note: the credit comes off what the customer owes on the original
 * invoice, whatever the invoice can no longer absorb is the customer's (the "excess") and waits for
 * a decision, and once the ledger is live the books follow (Dr sales returns and tax, Cr debtors).
 */
export class CreditNoteAccountingService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly engine: PostingEngine,
    private readonly ledger: CustomerLedgerService,
    private readonly wallets: WalletService,
    private readonly policies: CreditPolicyService,
    private readonly setup: PostingSetupService,
  ) {}

  /** What is still open on a credit note's excess. */
  private async openIn(tx: Pick<DrizzleDb, 'select'>, creditNoteId: string, excess: string): Promise<number> {
    const [r] = await tx
      .select({ n: sql<string>`COALESCE(SUM(${creditNoteResolutions.amount}), 0)` })
      .from(creditNoteResolutions)
      .where(eq(creditNoteResolutions.creditNoteId, creditNoteId));
    return toCents(excess) - toCents(r?.n ?? '0');
  }

  /** Called while a credit note is being issued, in its transaction. Returns null when the order has no customer account entry. */
  async recordIn(tx: Tx, p: { creditNote: CreditNoteRow; orderId: string; grossCents: number; actorId: string }): Promise<{ appliedCents: number; excessCents: number } | null> {
    const cn = p.creditNote;
    const ctx: FinanceContext = { companyId: cn.companyId, actor: { type: 'user', id: p.actorId }, origin: { surface: 'sales/credit-notes', action: 'issue' } };
    const [inv] = await tx
      .select()
      .from(customerLedgerEntries)
      .where(and(eq(customerLedgerEntries.orderId, p.orderId), eq(customerLedgerEntries.documentType, 'invoice')))
      .for('update');
    if (!inv) return null;
    const [order] = await tx.select().from(orders).where(eq(orders.id, p.orderId));
    if (!order) return null;
    const currency = inv.currency ?? cn.currency;
    const date = businessDate();

    const creditEntryId = await this.ledger.addEntry(tx, {
      companyId: cn.companyId,
      customerId: inv.customerId,
      documentType: 'credit_note',
      documentNo: cn.creditNoteNo,
      documentId: cn.id,
      orderId: p.orderId,
      description: `Credit note for ${order.orderNumber}`,
      amountCents: -p.grossCents,
      currency,
      postingDate: date,
      createdBy: p.actorId,
    });
    const plan = planCredit(Math.max(toCents(inv.remainingAmount), 0), p.grossCents);
    if (plan.appliedCents > 0) {
      await this.ledger.applyIn(tx, ctx, {
        customerId: inv.customerId,
        creditEntryId,
        applications: [{ entryId: inv.id, amountCents: plan.appliedCents }],
        postingDate: date,
        createdBy: p.actorId,
      });
    }

    const split = splitCredit(p.grossCents, toCents(order.subtotal), toCents(order.tax));
    const [s] = await tx.select().from(financeSettings).where(eq(financeSettings.companyId, cn.companyId));
    const goLive = s?.salesGlGoLive ?? null;
    const live = goLive !== null && date >= goLive;
    let registerId: string | null = null;
    if (live) {
      if (currency.toUpperCase() !== s.baseCurrency) {
        throw new FinanceError('FOREIGN_CURRENCY', `This order is in ${currency}; credit notes in a foreign currency are not posted to the general ledger yet.`);
      }
      const group = (await this.policies.forCustomer(tx, cn.companyId, inv.customerId, date)).groupCode;
      const [returns, receivables] = await Promise.all([
        this.setup.resolveGeneral(cn.companyId, s.defaultBusinessGroup, s.defaultProductGroup, 'sales_returns', date),
        this.setup.resolveCustomer(cn.companyId, group, 'receivables'),
      ]).catch((e: unknown) => {
        throw new FinanceError('POSTING_SETUP_MISSING', `The credit note cannot be posted: ${e instanceof Error ? e.message : 'posting setup is incomplete.'}`);
      });
      const lines = creditNoteLines(split, { salesReturns: returns.accountId, outputTax: s.outputTaxAccountId, receivables: receivables.accountId }, cn.creditNoteNo);
      const req: PostingRequest = {
        companyId: cn.companyId,
        idempotencyKey: `credit-note:${cn.id}`,
        postingDate: date,
        documentType: 'credit_note',
        documentNo: cn.creditNoteNo,
        description: `Credit note ${cn.creditNoteNo} for ${order.orderNumber}`,
        currency: s.baseCurrency,
        rate: '1',
        rateSource: 'base',
        lines: lines.map((l) => ({ accountId: l.accountId, debit: fromCents(l.debitCents), credit: fromCents(l.creditCents), description: l.description, sourceLedger: l.creditCents > 0 ? 'customer' : null, sourceEntryId: l.creditCents > 0 ? inv.customerId : null })),
        chainKey: order.branchId ?? 'general',
        branchId: order.branchId,
        origin: ctx.origin,
        source: { type: 'credit_note', id: cn.id },
        postedBy: 'engine',
      };
      registerId = (await this.engine.post(req, { canPostSoftClosed: true, canPostControlAccounts: true }, tx)).registerId;
    }

    await tx.insert(creditNoteAccounting).values({
      creditNoteId: cn.id,
      companyId: cn.companyId,
      customerId: inv.customerId,
      ledgerEntryId: creditEntryId,
      registerId,
      currency,
      gross: fromCents(p.grossCents),
      taxAmount: fromCents(split.taxCents),
      applied: fromCents(plan.appliedCents),
      excess: fromCents(plan.excessCents),
    });
    await this.decisions.record(
      {
        companyId: cn.companyId,
        subject: { type: 'credit_note', id: cn.id },
        action: 'finance.credit_note_accounted',
        actor: ctx.actor,
        inputs: { origin: ctx.origin, order: order.orderNumber },
        outcome: { gross: fromCents(p.grossCents), tax: fromCents(split.taxCents), appliedToInvoice: fromCents(plan.appliedCents), excess: fromCents(plan.excessCents), gl: live, registerId },
      },
      tx,
    );

    if (plan.excessCents > 0) {
      const policy = await this.policies.forCustomer(tx, cn.companyId, inv.customerId, date);
      if (policy.walletEnabled && policy.creditNoteExcess === 'wallet') {
        // Settle it automatically; if the wallet cannot take it (frozen, limit) it simply waits on the list.
        try {
          await tx.transaction((sp) => this.walletIn(sp, ctx, cn.id, plan.excessCents));
        } catch (error) {
          if (!(error instanceof FinanceError)) throw error;
        }
      }
    }
    return plan;
  }

  private async lockAccounting(tx: Tx, ctx: FinanceContext, creditNoteId: string) {
    const [a] = await tx
      .select()
      .from(creditNoteAccounting)
      .where(and(eq(creditNoteAccounting.companyId, ctx.companyId), eq(creditNoteAccounting.creditNoteId, creditNoteId)))
      .for('update');
    if (!a) throw new FinanceError('NOT_FOUND', 'That credit note has no account entry (it was issued before credit notes reached the customer account).');
    const [cn] = await tx.select().from(creditNotes).where(eq(creditNotes.id, creditNoteId));
    return { a, cn };
  }

  private async walletIn(tx: Tx, ctx: FinanceContext, creditNoteId: string, cents?: number, perms?: { canPostSoftClosed: boolean; canPostControlAccounts: boolean }) {
    const { a, cn } = await this.lockAccounting(tx, ctx, creditNoteId);
    const open = await this.openIn(tx, creditNoteId, a.excess);
    const amount = cents ?? open;
    if (amount <= 0 || amount > open) throw new FinanceError('NOTHING_TO_RESOLVE', open === 0 ? 'Nothing is left to resolve on this credit note.' : `Only ${fromCents(open)} is left to resolve.`);
    const moved = await this.wallets.moveCreditIn(tx, ctx, {
      customerId: a.customerId,
      currency: a.currency,
      ledgerEntryId: a.ledgerEntryId,
      cents: amount,
      type: 'credit_note',
      sourceType: 'credit_note',
      sourceId: creditNoteId,
      documentNo: cn.creditNoteNo,
      postingDate: businessDate(),
      rate: '1',
      branchId: cn.branchId,
      gl: { sourceType: 'credit_note', sourceId: creditNoteId },
      permissions: perms,
    });
    await tx.insert(creditNoteResolutions).values({
      companyId: ctx.companyId,
      creditNoteId,
      kind: 'wallet',
      amount: fromCents(amount),
      walletEntryId: moved.entryId,
      registerId: moved.registerId,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      origin: ctx.origin,
    });
    await this.decisions.record(
      { companyId: ctx.companyId, subject: { type: 'credit_note', id: creditNoteId }, action: 'finance.credit_note_excess_to_wallet', actor: ctx.actor, inputs: { origin: ctx.origin }, outcome: { amount: fromCents(amount), walletEntry: moved.entryId } },
      tx,
    );
  }

  /** Puts (part of) a credit note's excess into the customer's wallet. */
  async resolveToWallet(ctx: FinanceContext, creditNoteId: string, opts: { cents?: number; permissions?: { canPostSoftClosed: boolean; canPostControlAccounts: boolean } } = {}) {
    await this.db.transaction((tx) => this.walletIn(tx, ctx, creditNoteId, opts.cents, opts.permissions));
  }

  /** Uses a credit note's excess against the customer's other unpaid invoices. */
  async applyExcess(ctx: FinanceContext, creditNoteId: string, applications: PlannedApplication[] | 'oldest_first') {
    return await this.db.transaction(async (tx) => {
      const { a } = await this.lockAccounting(tx, ctx, creditNoteId);
      const open = await this.openIn(tx, creditNoteId, a.excess);
      if (open <= 0) throw new FinanceError('NOTHING_TO_RESOLVE', 'Nothing is left to resolve on this credit note.');
      const res = await this.ledger.applyIn(tx, ctx, {
        customerId: a.customerId,
        creditEntryId: a.ledgerEntryId,
        applications,
        postingDate: businessDate(),
        createdBy: ctx.actor.id,
      });
      await tx.insert(creditNoteResolutions).values({
        companyId: ctx.companyId,
        creditNoteId,
        kind: 'applied',
        amount: fromCents(res.appliedCents),
        applicationId: res.applicationId,
        actorType: ctx.actor.type,
        actorId: ctx.actor.id,
        origin: ctx.origin,
      });
      await this.decisions.record(
        { companyId: ctx.companyId, subject: { type: 'credit_note', id: creditNoteId }, action: 'finance.credit_note_excess_applied', actor: ctx.actor, inputs: { origin: ctx.origin }, outcome: { amount: fromCents(res.appliedCents) } },
        tx,
      );
      return res;
    });
  }

  /** Credit notes whose excess has not been settled yet, oldest first: the list nobody may forget. */
  async worklist(companyId: string) {
    const rows = await this.db
      .select({
        a: creditNoteAccounting,
        creditNoteNo: creditNotes.creditNoteNo,
        sourceRef: creditNotes.sourceRef,
        sourceId: creditNotes.sourceId,
        reasonCode: creditNotes.reasonCode,
        issuedAt: creditNotes.createdAt,
        customerName: customers.name,
        customerNumber: customers.number,
        resolved: sql<string>`COALESCE((SELECT SUM(r.amount) FROM credit_note_resolutions r WHERE r.credit_note_id = ${creditNoteAccounting.creditNoteId}), 0)`,
      })
      .from(creditNoteAccounting)
      .innerJoin(creditNotes, eq(creditNotes.id, creditNoteAccounting.creditNoteId))
      .innerJoin(customers, eq(customers.id, creditNoteAccounting.customerId))
      .where(and(eq(creditNoteAccounting.companyId, companyId), sql`${creditNoteAccounting.excess} > 0`))
      .orderBy(asc(creditNotes.createdAt));
    return rows
      .map((r) => ({ ...r, openCents: toCents(r.a.excess) - toCents(r.resolved) }))
      .filter((r) => r.openCents > 0);
  }

  /** Open invoices of the customer in the credit note's currency, for "use against other invoices". */
  async openInvoicesFor(companyId: string, creditNoteId: string) {
    const [a] = await this.db.select().from(creditNoteAccounting).where(and(eq(creditNoteAccounting.companyId, companyId), eq(creditNoteAccounting.creditNoteId, creditNoteId)));
    if (!a) return [];
    const open = await this.db
      .select()
      .from(customerLedgerEntries)
      .where(and(eq(customerLedgerEntries.customerId, a.customerId), eq(customerLedgerEntries.documentType, 'invoice'), eq(customerLedgerEntries.currency, a.currency), sql`${customerLedgerEntries.remainingAmount} > 0`))
      .orderBy(asc(customerLedgerEntries.dueDate));
    return open;
  }

  /** How credit notes were accounted for, keyed by credit-note id (for the order screen). */
  async summaries(companyId: string, ids: string[]) {
    if (ids.length === 0) return new Map<string, { applied: string; excess: string; openCents: number; resolutions: { kind: string; amount: string }[] }>();
    const accs = await this.db.select().from(creditNoteAccounting).where(and(eq(creditNoteAccounting.companyId, companyId), sql`${creditNoteAccounting.creditNoteId} IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`));
    const res = await this.db.select().from(creditNoteResolutions).where(and(eq(creditNoteResolutions.companyId, companyId), sql`${creditNoteResolutions.creditNoteId} IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`)).orderBy(desc(creditNoteResolutions.id));
    const out = new Map<string, { applied: string; excess: string; openCents: number; resolutions: { kind: string; amount: string }[] }>();
    for (const a of accs) {
      const mine = res.filter((r) => r.creditNoteId === a.creditNoteId);
      out.set(a.creditNoteId, { applied: a.applied, excess: a.excess, openCents: toCents(a.excess) - mine.reduce((n, r) => n + toCents(r.amount), 0), resolutions: mine.map((r) => ({ kind: r.kind, amount: r.amount })) });
    }
    return out;
  }
}
