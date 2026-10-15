import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  customerDetailedEntries,
  customerLedgerEntries,
  customerReceipts,
  customerWallets,
  customers,
  financeSalesPostings,
  financeSettings,
  receiptEvents,
  walletEntries,
  type CustomerReceiptRow,
  type CustomerWalletRow,
  type WalletEntryType,
} from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ReasonCodes } from '@/server/kernel/reason-codes/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { fromCents, planOldestFirst, toCents, type PlannedApplication } from '../domain/receivables';
import type { PostingRequest } from '../domain/types';
import { autoApplyAmount, checkCredit, checkDebit, type CreditPolicy } from '../domain/wallet';
import { NO_SPECIAL_PERMISSIONS, type PostingEngine, type PostingPermissions, type Tx } from '../engine';
import { FinanceError, type FinanceContext } from '../errors';
import type { PostingSetupService } from '../posting-setup-service';
import type { SalesPostingService } from '../sales-posting-service';
import type { CreditPolicyService } from './credit-policy-service';
import type { CustomerLedgerService } from './customer-ledger-service';

import { has } from '@/lib/has';

type Reader = Pick<DrizzleDb, 'select'>;

/**
 * The customer wallet: credit the business holds for a customer, a liability ("customer deposits")
 * and never a debtor. Money gets in from an unapplied receipt or an advance deposit, and gets out
 * by paying an invoice (utilisation) or an order at the till (tender). It can never go below zero.
 */
export class WalletService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly engine: PostingEngine,
    private readonly ledger: CustomerLedgerService,
    private readonly policies: CreditPolicyService,
    private readonly salesPosting: SalesPostingService,
    private readonly setup: PostingSetupService,
    private readonly reasons: ReasonCodes,
  ) {}

  // ── the wallet row ───────────────────────────────────────────────────────

  /** Finds the customer's wallet in a currency (creating it on first use) and locks it. */
  private async lockWallet(tx: Tx, companyId: string, customerId: string, currency: string): Promise<CustomerWalletRow> {
    await tx.insert(customerWallets).values({ companyId, customerId, currency }).onConflictDoNothing({ target: [customerWallets.customerId, customerWallets.currency] });
    const [w] = await tx
      .select()
      .from(customerWallets)
      .where(and(eq(customerWallets.customerId, customerId), eq(customerWallets.currency, currency)))
      .for('update');
    if (!w) throw new FinanceError('WALLET_MISSING', 'The wallet could not be opened.');
    return w;
  }

  private async record(
    tx: Tx,
    ctx: FinanceContext,
    w: CustomerWalletRow,
    p: {
      type: WalletEntryType;
      cents: number; // signed
      sourceType?: string;
      sourceId?: string;
      ledgerEntryId?: string | null;
      postingDate: string;
      registerId?: string | null;
      reason?: { code?: string | null; text?: string | null };
    },
  ): Promise<number> {
    const [row] = await tx
      .insert(walletEntries)
      .values({
        companyId: w.companyId,
        walletId: w.id,
        customerId: w.customerId,
        entryType: p.type,
        amount: fromCents(p.cents),
        currency: w.currency,
        sourceType: p.sourceType ?? null,
        sourceId: p.sourceId ?? null,
        ledgerEntryId: p.ledgerEntryId ?? null,
        reasonCode: p.reason?.code ?? null,
        reasonText: p.reason?.text ?? null,
        registerId: p.registerId ?? null,
        postingDate: p.postingDate,
        actorType: ctx.actor.type,
        actorId: ctx.actor.id,
        origin: ctx.origin,
      })
      .returning({ id: walletEntries.id });
    await tx
      .update(customerWallets)
      .set({ balance: sql`${customerWallets.balance} + ${fromCents(p.cents)}::numeric`, updatedAt: new Date() })
      .where(eq(customerWallets.id, w.id));
    return row.id;
  }

  private async credit(
    tx: Tx,
    ctx: FinanceContext,
    p: { customerId: string; currency: string; cents: number; type: 'deposit' | 'overpayment' | 'reversal'; sourceType: string; sourceId: string; ledgerEntryId?: string; postingDate: string; registerId?: string | null; reason?: { code?: string | null; text?: string | null } },
  ): Promise<{ entryId: number; wallet: CustomerWalletRow }> {
    const w = await this.lockWallet(tx, ctx.companyId, p.customerId, p.currency);
    if (p.type !== 'reversal') {
      const policy = await this.policies.forCustomer(tx, ctx.companyId, p.customerId, p.postingDate);
      const issue = checkCredit(policy, { status: w.status, balanceCents: toCents(w.balance) }, p.cents, p.type);
      if (issue) throw new FinanceError(issue.code, issue.message);
    }
    const entryId = await this.record(tx, ctx, w, { type: p.type, cents: p.cents, sourceType: p.sourceType, sourceId: p.sourceId, ledgerEntryId: p.ledgerEntryId, postingDate: p.postingDate, registerId: p.registerId, reason: p.reason });
    return { entryId, wallet: w };
  }

  private async debit(
    tx: Tx,
    ctx: FinanceContext,
    p: { customerId: string; currency: string; cents: number; type: 'utilisation' | 'tender' | 'cash_out' | 'reversal'; sourceType: string; sourceId: string; ledgerEntryId?: string; postingDate: string; registerId?: string | null; reason?: { code?: string | null; text?: string | null } },
  ): Promise<{ entryId: number; wallet: CustomerWalletRow }> {
    const w = await this.lockWallet(tx, ctx.companyId, p.customerId, p.currency);
    const policy = await this.policies.forCustomer(tx, ctx.companyId, p.customerId, p.postingDate);
    const issue = checkDebit(policy, { status: w.status, balanceCents: toCents(w.balance) }, p.cents);
    if (issue) throw new FinanceError(issue.code, issue.message);
    const entryId = await this.record(tx, ctx, w, { type: p.type, cents: -p.cents, sourceType: p.sourceType, sourceId: p.sourceId, ledgerEntryId: p.ledgerEntryId, postingDate: p.postingDate, registerId: p.registerId, reason: p.reason });
    return { entryId, wallet: w };
  }

  // ── money in: from a receipt ─────────────────────────────────────────────

  /** What a receipt still has unapplied, in cents (never negative). */
  async receiptUnappliedIn(tx: Reader, ledgerEntryId: string): Promise<number> {
    const [e] = await tx.select({ r: customerLedgerEntries.remainingAmount }).from(customerLedgerEntries).where(eq(customerLedgerEntries.id, ledgerEntryId));
    return e ? Math.max(-toCents(e.r), 0) : 0;
  }

  /**
   * Moves unapplied credit from a customer-ledger entry (a receipt, a credit note) into the
   * customer's wallet: the account is relieved of the credit and the wallet liability takes it
   * (Dr trade debtors, Cr customer deposits once the books are live). Checks the policy, locks the
   * wallet and the entry, and leaves the caller to record what it needs to about the act.
   */
  async moveCreditIn(
    tx: Tx,
    ctx: FinanceContext,
    p: {
      customerId: string;
      currency: string;
      ledgerEntryId: string;
      cents: number;
      type: 'deposit' | 'overpayment' | 'credit_note';
      sourceType: string;
      sourceId: string;
      documentNo: string;
      postingDate: string;
      rate: string;
      branchId: string | null;
      gl: { sourceType: string; sourceId: string };
      permissions?: PostingPermissions;
    },
  ): Promise<{ entryId: number; registerId: string | null; live: boolean }> {
    const policy = await this.policies.forCustomer(tx, ctx.companyId, p.customerId, p.postingDate);
    const w = await this.lockWallet(tx, ctx.companyId, p.customerId, p.currency);
    const issue = checkCredit(policy, { status: w.status, balanceCents: toCents(w.balance) }, p.cents, p.type === 'deposit' ? 'deposit' : 'overpayment');
    if (issue) throw new FinanceError(issue.code, issue.message);

    const [s] = await tx.select().from(financeSettings).where(eq(financeSettings.companyId, ctx.companyId));
    const live = Boolean(s?.salesGlGoLive) && p.postingDate >= s.salesGlGoLive!;
    let registerId: string | null = null;
    if (live) {
      const [receivables, deposits] = await Promise.all([
        this.setup.resolveCustomer(ctx.companyId, policy.groupCode, 'receivables'),
        this.setup.resolveCustomer(ctx.companyId, policy.groupCode, 'customer_deposits'),
      ]).catch((e: unknown) => {
        throw new FinanceError('POSTING_SETUP_MISSING', e instanceof Error ? e.message : 'Posting setup is incomplete.');
      });
      const req: PostingRequest = {
        companyId: ctx.companyId,
        idempotencyKey: `${p.gl.sourceType}:${p.gl.sourceId}:wallet:${randomUUID()}`,
        postingDate: p.postingDate,
        documentType: 'wallet_credit',
        documentNo: p.documentNo,
        description: `${p.documentNo} to ${policy.label.toLowerCase()}`,
        currency: p.currency,
        rate: p.rate,
        rateSource: p.currency === s.baseCurrency ? 'base' : 'manual',
        lines: [
          { accountId: receivables.accountId, debit: fromCents(p.cents), credit: '0', description: `${p.documentNo} moved to ${policy.label.toLowerCase()}`, sourceLedger: 'customer', sourceEntryId: p.customerId },
          { accountId: deposits.accountId, debit: '0', credit: fromCents(p.cents), description: `Customer deposits: ${p.documentNo}`, sourceLedger: 'wallet', sourceEntryId: p.customerId },
        ],
        chainKey: p.branchId ?? 'general',
        branchId: p.branchId,
        origin: ctx.origin,
        source: { type: p.gl.sourceType, id: p.gl.sourceId },
        postedBy: 'engine',
      };
      registerId = (await this.engine.post(req, p.permissions ?? NO_SPECIAL_PERMISSIONS, tx)).registerId;
    }
    await this.ledger.transferCreditIn(tx, ctx, p.ledgerEntryId, p.cents, { postingDate: p.postingDate, createdBy: ctx.actor.id, registerId });
    const entryId = await this.record(tx, ctx, w, { type: p.type, cents: p.cents, sourceType: p.sourceType, sourceId: p.sourceId, ledgerEntryId: p.ledgerEntryId, postingDate: p.postingDate, registerId });
    return { entryId, registerId, live };
  }

  /** Moves the unapplied part of a posted receipt into the customer's wallet. `cents` defaults to all of it. */
  async moveReceiptIn(
    tx: Tx,
    ctx: FinanceContext,
    r: CustomerReceiptRow,
    opts: { cents?: number; permissions?: PostingPermissions } = {},
  ): Promise<{ movedCents: number }> {
    if (r.status !== 'posted' || !has(r.ledgerEntryId)) throw new FinanceError('NOT_POSTED', 'Only a posted receipt can be moved to the wallet.');
    const unapplied = await this.receiptUnappliedIn(tx, r.ledgerEntryId);
    const cents = opts.cents ?? unapplied;
    if (cents <= 0 || cents > unapplied) throw new FinanceError('NOTHING_TO_MOVE', unapplied === 0 ? 'This receipt has nothing unapplied to move.' : `Only ${fromCents(unapplied)} is unapplied.`);
    const moved = await this.moveCreditIn(tx, ctx, {
      customerId: r.customerId,
      currency: r.currency,
      ledgerEntryId: r.ledgerEntryId,
      cents,
      type: r.isDeposit ? 'deposit' : 'overpayment',
      sourceType: 'customer_receipt',
      sourceId: r.id,
      documentNo: r.number,
      postingDate: r.postingDate,
      rate: r.rate,
      branchId: r.branchId,
      gl: { sourceType: 'customer_receipt', sourceId: r.id },
      permissions: opts.permissions,
    });
    await tx.insert(receiptEvents).values({
      receiptId: r.id,
      event: 'moved_to_wallet',
      fromStatus: r.status,
      toStatus: r.status,
      data: { amount: fromCents(cents), walletEntry: moved.entryId, gl: moved.live },
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      origin: ctx.origin,
    });
    await this.decisions.record(
      { companyId: ctx.companyId, subject: { type: 'customer_receipt', id: r.id }, action: 'finance.receipt_moved_to_wallet', actor: ctx.actor, inputs: { origin: ctx.origin }, outcome: { amount: fromCents(cents), walletEntry: moved.entryId, gl: moved.live } },
      tx,
    );
    return { movedCents: cents };
  }

  /** Same, as its own action on a posted receipt. */
  async moveReceiptToWallet(ctx: FinanceContext, receiptId: string, opts: { cents?: number; permissions?: PostingPermissions } = {}) {
    return await this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(customerReceipts).where(and(eq(customerReceipts.companyId, ctx.companyId), eq(customerReceipts.id, receiptId))).for('update');
      if (!r) throw new FinanceError('NOT_FOUND', 'That receipt does not exist.');
      return await this.moveReceiptIn(tx, ctx, r, opts);
    });
  }

  /**
   * Called when a receipt is reversed: whatever of it went to the wallet must still be there to
   * take back, and goes back onto the customer account so the reversal can close it.
   */
  async returnReceiptCreditIn(tx: Tx, ctx: FinanceContext, r: CustomerReceiptRow, reason: { code: string; text: string | null }): Promise<void> {
    if (!has(r.ledgerEntryId)) return;
    const [moved] = await tx
      .select({ t: sql<string>`COALESCE(SUM(${customerDetailedEntries.amount}), 0)` })
      .from(customerDetailedEntries)
      .where(and(eq(customerDetailedEntries.ledgerEntryId, r.ledgerEntryId), eq(customerDetailedEntries.entryType, 'wallet_transfer')));
    const cents = toCents(moved?.t ?? '0');
    if (cents <= 0) return;
    const policy = await this.policies.forCustomer(tx, ctx.companyId, r.customerId, r.postingDate);
    const wallet = await this.lockWallet(tx, ctx.companyId, r.customerId, r.currency);
    const issue = checkDebit({ ...policy, walletEnabled: true }, { status: 'active', balanceCents: toCents(wallet.balance) }, cents);
    if (issue) {
      throw new FinanceError('WALLET_USED', `${fromCents(cents)} of this receipt went to the ${policy.label.toLowerCase()} and only ${fromCents(toCents(wallet.balance))} is left in it, so the customer has already used it. Reverse that use first.`);
    }
    await this.record(tx, ctx, wallet, { type: 'reversal', cents: -cents, sourceType: 'customer_receipt', sourceId: r.id, ledgerEntryId: r.ledgerEntryId, postingDate: businessDate(), reason });
    await this.ledger.transferCreditIn(tx, ctx, r.ledgerEntryId, -cents, { postingDate: businessDate(), createdBy: ctx.actor.id, reasonCode: reason.code, reasonText: reason.text });
  }

  // ── money out: pay invoices ──────────────────────────────────────────────

  /** Pays open invoices from the wallet (by hand). Returns the amount used. */
  async utilise(
    ctx: FinanceContext,
    input: { customerId: string; currency: string; applications: PlannedApplication[] | 'oldest_first'; maxCents?: number },
  ): Promise<{ usedCents: number; walletEntryId: number }> {
    const out = await this.db.transaction((tx) => this.utiliseIn(tx, ctx, input));
    // post it to the books straight away rather than waiting for the next minute
    await this.salesPosting.attempt(out.postingId).catch(() => undefined);
    return { usedCents: out.usedCents, walletEntryId: out.walletEntryId };
  }

  private async utiliseIn(
    tx: Tx,
    ctx: FinanceContext,
    input: { customerId: string; currency: string; applications: PlannedApplication[] | 'oldest_first'; maxCents?: number },
  ): Promise<{ usedCents: number; walletEntryId: number; postingId: string }> {
    const date = businessDate();
    const wallet = await this.lockWallet(tx, ctx.companyId, input.customerId, input.currency);
    const balance = toCents(wallet.balance);
    const policyNow = await this.policies.forCustomer(tx, ctx.companyId, input.customerId, date);
    if (wallet.status === 'frozen') throw new FinanceError('WALLET_FROZEN', `This customer's ${policyNow.label.toLowerCase()} is frozen.`);
    if (balance <= 0) throw new FinanceError('WALLET_INSUFFICIENT', `There is nothing in the ${policyNow.label.toLowerCase()}.`);
    let planned: PlannedApplication[];
    if (input.applications === 'oldest_first') {
      const open = await tx
        .select()
        .from(customerLedgerEntries)
        .where(and(eq(customerLedgerEntries.companyId, ctx.companyId), eq(customerLedgerEntries.customerId, input.customerId), eq(customerLedgerEntries.documentType, 'invoice'), eq(customerLedgerEntries.currency, input.currency), sql`${customerLedgerEntries.remainingAmount} > 0`));
      planned = planOldestFirst(
        open.map((o) => ({ id: o.id, remainingCents: toCents(o.remainingAmount), dueDate: o.dueDate, createdAt: o.createdAt, documentNo: o.documentNo })),
        Math.min(balance, input.maxCents ?? balance),
      );
      if (planned.length === 0) throw new FinanceError('NOTHING_TO_APPLY', 'There is nothing open to pay.');
    } else {
      planned = input.applications;
    }
    const total = planned.reduce((n, a) => n + a.amountCents, 0);
    const policy = await this.policies.forCustomer(tx, ctx.companyId, input.customerId, date);
    const issue = checkDebit(policy, { status: wallet.status, balanceCents: balance }, total);
    if (issue) throw new FinanceError(issue.code, issue.message);

    const ledgerEntryId = randomUUID();
    const walletEntryId = await this.record(tx, ctx, wallet, { type: 'utilisation', cents: -total, sourceType: 'wallet_use', sourceId: ledgerEntryId, ledgerEntryId, postingDate: date });
    await this.ledger.addEntry(tx, {
      id: ledgerEntryId,
      companyId: ctx.companyId,
      customerId: input.customerId,
      documentType: 'wallet_use',
      documentNo: `WAL-${walletEntryId}`,
      description: `${policy.label} used`,
      amountCents: -total,
      currency: input.currency,
      postingDate: date,
      createdBy: ctx.actor.id,
    });
    await this.ledger.applyIn(tx, ctx, { customerId: input.customerId, creditEntryId: ledgerEntryId, applications: planned, postingDate: date, createdBy: ctx.actor.id });
    await this.salesPosting.enqueue(tx, { companyId: ctx.companyId, kind: 'wallet_use', subjectId: String(walletEntryId) });
    await this.decisions.record(
      { companyId: ctx.companyId, subject: { type: 'wallet_entry', id: String(walletEntryId) }, action: 'finance.wallet_used', actor: ctx.actor, inputs: { origin: ctx.origin, customerId: input.customerId }, outcome: { amount: fromCents(total), invoices: planned.length } },
      tx,
    );
    const [post] = await tx.select({ id: financeSalesPostings.id }).from(financeSalesPostings).where(and(eq(financeSalesPostings.companyId, ctx.companyId), eq(financeSalesPostings.kind, 'wallet_use'), eq(financeSalesPostings.subjectId, String(walletEntryId))));
    return { usedCents: total, walletEntryId, postingId: post?.id ?? '' };
  }

  /**
   * On a new credit invoice, pays it from the wallet when the policy says to. Never lets a
   * wallet problem stop the sale: it runs in a savepoint and gives up quietly.
   */
  async autoApplyToInvoiceIn(
    tx: Tx,
    p: { companyId: string; customerId: string; currency: string; invoiceEntryId: string; invoiceCents: number },
  ): Promise<number> {
    try {
      const policy = await this.policies.forCustomer(tx, p.companyId, p.customerId);
      if (!policy.walletEnabled || policy.autoApply === 'never') return 0;
      const [w] = await tx.select().from(customerWallets).where(and(eq(customerWallets.customerId, p.customerId), eq(customerWallets.currency, p.currency)));
      if (!w || w.status === 'frozen') return 0;
      const cents = autoApplyAmount(policy, toCents(w.balance), p.invoiceCents);
      if (cents <= 0) return 0;
      const ctx: FinanceContext = { companyId: p.companyId, actor: { type: 'system', id: 'wallet-auto-apply' }, origin: { surface: 'sales/invoice', action: 'wallet_auto_apply' } };
      return await tx.transaction(async (sp) => {
        const out = await this.utiliseIn(sp, ctx, { customerId: p.customerId, currency: p.currency, applications: [{ entryId: p.invoiceEntryId, amountCents: cents }] });
        return out.usedCents;
      });
    } catch (error) {
      console.error('[wallet] automatic use failed; the sale goes ahead without it', error);
      return 0;
    }
  }

  /** Undoes a use of the wallet: the invoices are owed again and the money goes back in. */
  async reverseUtilisation(ctx: FinanceContext, walletEntryId: number, reason: { code: string; text?: string | null }, perms: PostingPermissions = NO_SPECIAL_PERMISSIONS) {
    const rs = await this.reasons.require(ctx.companyId, reason, 'wallet');
    await this.db.transaction(async (tx) => {
      const [e] = await tx.select().from(walletEntries).where(and(eq(walletEntries.companyId, ctx.companyId), eq(walletEntries.id, walletEntryId)));
      if (!e || e.entryType !== 'utilisation' || !has(e.ledgerEntryId)) throw new FinanceError('NOT_FOUND', 'That is not a use of the wallet.');
      const wallet = await this.lockWallet(tx, ctx.companyId, e.customerId, e.currency);
      const [again] = await tx.select({ id: walletEntries.id }).from(walletEntries).where(and(eq(walletEntries.sourceType, 'wallet_entry'), eq(walletEntries.sourceId, String(walletEntryId)), eq(walletEntries.entryType, 'reversal')));
      if (again) throw new FinanceError('ALREADY_REVERSED', 'That use has already been undone.');
      for (const applicationId of await this.ledger.activeApplicationIds(tx, e.ledgerEntryId)) {
        await this.ledger.unapplyIn(tx, ctx, { applicationId, reasonCode: rs.code, reasonText: rs.text, postingDate: businessDate(), createdBy: ctx.actor.id });
      }
      await this.ledger.closeCreditIn(tx, ctx, e.ledgerEntryId, { postingDate: businessDate(), reasonCode: rs.code, reasonText: rs.text, createdBy: ctx.actor.id });
      await this.record(tx, ctx, wallet, { type: 'reversal', cents: -toCents(e.amount), sourceType: 'wallet_entry', sourceId: String(walletEntryId), ledgerEntryId: e.ledgerEntryId, postingDate: businessDate(), reason: rs });
      // The books: undo the posting if it was made, otherwise it never will be.
      const [post] = await tx.select().from(financeSalesPostings).where(and(eq(financeSalesPostings.companyId, ctx.companyId), eq(financeSalesPostings.kind, 'wallet_use'), eq(financeSalesPostings.subjectId, String(walletEntryId)))).for('update');
      if (post?.status === 'posted' && has(post.registerId)) {
        await this.engine.reverse({ companyId: ctx.companyId, registerId: post.registerId, postingDate: businessDate(), reasonCode: rs.code, reasonText: rs.text, origin: ctx.origin, permissions: perms, tx });
      } else if (post) {
        await tx.update(financeSalesPostings).set({ status: 'skipped' }).where(eq(financeSalesPostings.id, post.id));
      }
      await this.decisions.record(
        { companyId: ctx.companyId, subject: { type: 'wallet_entry', id: String(walletEntryId) }, action: 'finance.wallet_use_reversed', actor: ctx.actor, reason: rs, inputs: { origin: ctx.origin } },
        tx,
      );
    });
  }

  /** At the till or checkout: the wallet pays (part of) an order. No customer-ledger entry: a cash sale has no debtor. */
  async tenderIn(
    tx: Tx,
    p: { companyId: string; customerId: string; currency: string; maxCents: number; orderId: string; actorId: string },
  ): Promise<number> {
    const ctx: FinanceContext = { companyId: p.companyId, actor: { type: 'user', id: p.actorId }, origin: { surface: 'sales/tender', action: 'wallet_tender' } };
    const w = await this.lockWallet(tx, p.companyId, p.customerId, p.currency);
    const cents = Math.min(toCents(w.balance), p.maxCents);
    if (cents <= 0) throw new FinanceError('WALLET_INSUFFICIENT', 'There is nothing in the wallet to use.');
    await this.debit(tx, ctx, { customerId: p.customerId, currency: p.currency, cents, type: 'tender', sourceType: 'order', sourceId: p.orderId, postingDate: businessDate() });
    return cents;
  }

  /** A cancelled order gives back what its wallet tender took. Idempotent. */
  async reverseTenderIn(tx: Tx, orderId: string): Promise<number> {
    const rows = await tx.select().from(walletEntries).where(and(eq(walletEntries.sourceType, 'order'), eq(walletEntries.sourceId, orderId), eq(walletEntries.entryType, 'tender')));
    let back = 0;
    for (const e of rows) {
      const [done] = await tx.select({ id: walletEntries.id }).from(walletEntries).where(and(eq(walletEntries.sourceType, 'order_cancel'), eq(walletEntries.sourceId, orderId), eq(walletEntries.walletId, e.walletId)));
      if (done) continue;
      const w = await this.lockWallet(tx, e.companyId, e.customerId, e.currency);
      const ctx: FinanceContext = { companyId: e.companyId, actor: { type: 'system', id: 'order-cancel' }, origin: { surface: 'sales/orders', action: 'cancel' } };
      await this.record(tx, ctx, w, { type: 'reversal', cents: -toCents(e.amount), sourceType: 'order_cancel', sourceId: orderId, postingDate: businessDate() });
      back += -toCents(e.amount);
    }
    return back;
  }

  /** A refund paid out of the wallet: takes the money out when the refund is approved. */
  async cashOutIn(tx: Tx, ctx: FinanceContext, p: { customerId: string; currency: string; cents: number; refundId: string; postingDate: string }): Promise<number> {
    const { entryId } = await this.debit(tx, ctx, { customerId: p.customerId, currency: p.currency, cents: p.cents, type: 'cash_out', sourceType: 'refund', sourceId: p.refundId, postingDate: p.postingDate });
    return entryId;
  }

  /** The refund did not go ahead: the money goes back into the wallet. */
  async undoCashOutIn(tx: Tx, ctx: FinanceContext, p: { customerId: string; currency: string; cents: number; refundId: string; reason: { code?: string | null; text?: string | null } }): Promise<void> {
    const w = await this.lockWallet(tx, ctx.companyId, p.customerId, p.currency);
    await this.record(tx, ctx, w, { type: 'reversal', cents: p.cents, sourceType: 'refund_cancel', sourceId: p.refundId, postingDate: businessDate(), reason: p.reason });
  }

  // ── freeze, read ─────────────────────────────────────────────────────────

  async setFrozen(ctx: FinanceContext, customerId: string, currency: string, frozen: boolean, reason?: string) {
    await this.db.transaction(async (tx) => {
      const w = await this.lockWallet(tx, ctx.companyId, customerId, currency);
      await tx.update(customerWallets).set({ status: frozen ? 'frozen' : 'active', updatedAt: new Date() }).where(eq(customerWallets.id, w.id));
      await this.decisions.record(
        { companyId: ctx.companyId, subject: { type: 'customer_wallet', id: w.id }, action: frozen ? 'finance.wallet_frozen' : 'finance.wallet_unfrozen', actor: ctx.actor, reason: has(reason) ? { text: reason } : undefined, inputs: { origin: ctx.origin } },
        tx,
      );
    });
  }

  async forCustomer(companyId: string, customerId: string) {
    const [wallets, policy] = await Promise.all([
      this.db.select().from(customerWallets).where(and(eq(customerWallets.companyId, companyId), eq(customerWallets.customerId, customerId))),
      this.policies.forCustomer(this.db, companyId, customerId),
    ]);
    const entries = wallets.length !== 0
      ? await this.db.select().from(walletEntries).where(and(eq(walletEntries.companyId, companyId), eq(walletEntries.customerId, customerId))).orderBy(desc(walletEntries.id)).limit(100)
      : [];
    return { wallets, entries, policy };
  }

  /** Total owed to customers, and the biggest wallets. */
  async report(companyId: string, limit = 100) {
    const [totals, top] = await Promise.all([
      this.db.execute<{ currency: string; total: string; holders: number }>(sql`
        SELECT currency, COALESCE(SUM(balance), 0)::text AS total, count(*) FILTER (WHERE balance > 0)::int AS holders
        FROM customer_wallets WHERE company_id = ${companyId}::uuid GROUP BY currency`),
      this.db
        .select({ w: customerWallets, name: customers.name, number: customers.number })
        .from(customerWallets)
        .innerJoin(customers, eq(customers.id, customerWallets.customerId))
        .where(and(eq(customerWallets.companyId, companyId), sql`${customerWallets.balance} > 0`))
        .orderBy(desc(customerWallets.balance))
        .limit(limit),
    ]);
    return { totals: [...totals], top };
  }

  /** The customer-deposits account in the books against the wallets, per account (base currency). */
  async reconciliation(companyId: string) {
    const [s] = await this.db.select().from(financeSettings).where(eq(financeSettings.companyId, companyId));
    if (!s) return [];
    const rows = await this.db.execute<{ account_id: string; no: string; name: string; sub: string }>(sql`
      SELECT g.customer_deposits_account_id AS account_id, a.no, a.name,
             COALESCE(SUM(w.balance), 0)::text AS sub
      FROM customer_posting_groups g
      JOIN gl_accounts a ON a.id = g.customer_deposits_account_id
      LEFT JOIN customers c ON COALESCE(c.posting_group_code, ${s.defaultCustomerGroup}) = g.code AND c.company_id = g.company_id
      LEFT JOIN customer_wallets w ON w.customer_id = c.id AND w.currency = ${s.baseCurrency}
      WHERE g.company_id = ${companyId}::uuid
      GROUP BY g.customer_deposits_account_id, a.no, a.name`);
    const out = [];
    for (const r of rows) {
      const [bal] = await this.db.execute<{ net: string }>(sql`
        SELECT COALESCE(SUM(base_credit - base_debit), 0)::text AS net FROM gl_account_balances
        WHERE company_id = ${companyId}::uuid AND account_id = ${r.account_id}::uuid`);
      const gl = toCents(Number(bal?.net ?? 0).toFixed(2));
      const sub = toCents(r.sub);
      out.push({ accountNo: r.no, accountName: r.name, glCents: gl, walletsCents: sub, diffCents: gl - sub });
    }
    return out;
  }
}
