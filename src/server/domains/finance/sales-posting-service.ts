import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  accountingPeriods,
  bankAccounts,
  bankLedgerEntries,
  customerLedgerEntries,
  customers,
  giftCardLedger,
  giftCards,
  loyaltyLedger,
  loyaltyPrograms,
  walletEntries,
  financeSalesPostings,
  financeSettings,
  glAccounts,
  orderTenders,
  orders,
  paymentMethods,
  paymentProviderConfigs,
  type FinanceSalesPostingRow,
  type SalesPostingKind,
} from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { fromCents, toCents } from './domain/receivables';
import { formatAmount, parseAmount } from './domain/amount';
import { baseValue, toCentsRounded } from './domain/fx';
import {
  cashSaleLines,
  creditInvoiceLines,
  rebateLines,
  type PlannedLine,
  type SaleAccounts,
} from './domain/sales-posting';
import type { PostingRequest } from './domain/types';
import type { PostingEngine, Tx } from './engine';
import { FinanceError, type FinanceContext } from './errors';
import type { PostingSetupService } from './posting-setup-service';
import type { FxService } from './fx-service';

import { has, orElse, required } from '@/lib/values';

type Writer = DrizzleDb | Tx;

const MAX_BACKOFF_MINUTES = 60;

export interface ReadinessCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  /** A problem that stops posting, vs. something worth knowing. */
  blocking: boolean;
}

/** A liability that paid part of a foreign order: how much of it the sale took (in the order's currency) and what the books carried that at. */
interface TenderCarry {
  accountId: string;
  cents: number;
  base: bigint;
}

/**
 * Takes sales events (a credit invoice, a cash sale confirmed paid, a rebate credited) to the
 * general ledger. The business event is saved first and queued in the same transaction; this
 * service posts the queue, retrying with a growing delay, so a set-up mistake in the accounts can
 * never stop a customer from buying. Nothing is posted before the go-live date.
 */
export class SalesPostingService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly engine: PostingEngine,
    private readonly setup: PostingSetupService,
    private readonly fx: FxService,
  ) {}

  // ── queueing ─────────────────────────────────────────────────────────────

  /**
   * Queues an event, in the caller's transaction. Invoices and rebates are queued only once the
   * ledger is live; a cash sale and a credit customer's gateway payment are always queued, because their bank movement is recorded either way.
   */
  async enqueue(
    w: Writer,
    e: { companyId: string; kind: SalesPostingKind; subjectId: string; eventDate?: string },
  ): Promise<boolean> {
    const date = e.eventDate ?? businessDate();
    // A shared lock on the settings row: go-live waits for in-flight sales, and a sale that starts
    // after it sees the ledger as live. Nothing is lost or counted twice around the switch-over.
    const [s] = await w
      .select({ goLive: financeSettings.salesGlGoLive })
      .from(financeSettings)
      .where(eq(financeSettings.companyId, e.companyId))
      .for('share');
    if (!s) return false; // finance is not set up: nothing to post to
    const live = s.goLive !== null && date >= s.goLive;
    if (!live && e.kind !== 'cash_sale' && e.kind !== 'credit_payment') return false;
    await w
      .insert(financeSalesPostings)
      .values({ companyId: e.companyId, kind: e.kind, subjectId: e.subjectId, eventDate: date })
      .onConflictDoNothing({ target: [financeSalesPostings.companyId, financeSalesPostings.kind, financeSalesPostings.subjectId] });
    return true;
  }

  async isLive(companyId: string): Promise<boolean> {
    const [s] = await this.db.select({ g: financeSettings.salesGlGoLive }).from(financeSettings).where(eq(financeSettings.companyId, companyId));
    return Boolean(s?.g);
  }

  // ── processing ───────────────────────────────────────────────────────────

  /** Posts what is due, oldest first. Safe to run from several workers at once. */
  async processDue(limit = 100): Promise<{ posted: number; failed: number }> {
    const due = await this.db
      .select({ id: financeSalesPostings.id })
      .from(financeSalesPostings)
      .where(and(inArray(financeSalesPostings.status, ['pending', 'failed']), lte(financeSalesPostings.nextAttemptAt, sql`now()`)))
      .orderBy(asc(financeSalesPostings.nextAttemptAt))
      .limit(limit);
    let posted = 0;
    let failed = 0;
    for (const { id } of due) {
      if (await this.attempt(id)) posted += 1;
      else failed += 1;
    }
    return { posted, failed };
  }

  /** One attempt. Returns true when the event is now posted (or was already). */
  async attempt(id: string): Promise<boolean> {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(financeSalesPostings)
          .where(and(eq(financeSalesPostings.id, id), inArray(financeSalesPostings.status, ['pending', 'failed'])))
          .for('update', { skipLocked: true });
        if (!row) return true; // someone else has it, or it is done
        const registerId = await this.postRow(tx, row);
        await tx
          .update(financeSalesPostings)
          .set({ status: 'posted', registerId, lastError: null, postedAt: new Date(), attempts: sql`${financeSalesPostings.attempts} + 1` })
          .where(eq(financeSalesPostings.id, id));
        return true;
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'Unknown error').slice(0, 500);
      await this.db
        .update(financeSalesPostings)
        .set({
          status: 'failed',
          lastError: message,
          attempts: sql`${financeSalesPostings.attempts} + 1`,
          // 1, 2, 4 … minutes, at most an hour: quick to recover once the setup is fixed.
          nextAttemptAt: sql`now() + make_interval(mins => LEAST(${MAX_BACKOFF_MINUTES}, power(2, LEAST(${financeSalesPostings.attempts}, 6))::int))`,
        })
        .where(eq(financeSalesPostings.id, id));
      return false;
    }
  }

  private async settings(w: Writer, companyId: string) {
    const [s] = await w.select().from(financeSettings).where(eq(financeSettings.companyId, companyId));
    if (!s) throw new Error('Finance has not been set up yet.');
    return s;
  }

  private async groupFor(w: Writer, customerId: string | null, fallback: string): Promise<string> {
    if (!has(customerId)) return fallback;
    const [c] = await w.select({ g: customers.postingGroupCode }).from(customers).where(eq(customers.id, customerId));
    return c?.g ?? fallback;
  }

  private async saleAccounts(
    companyId: string,
    s: Awaited<ReturnType<SalesPostingService['settings']>>,
    group: string,
    date: string,
    figures: { taxCents: number; shippingCents: number },
  ): Promise<SaleAccounts> {
    const sales = await this.setup.resolveGeneral(companyId, s.defaultBusinessGroup, s.defaultProductGroup, 'sales', date);
    const serviceCharge =
      figures.shippingCents > 0 ? (await this.setup.resolveCustomer(companyId, group, 'service_charge')).accountId : null;
    if (figures.taxCents > 0 && !has(s.outputTaxAccountId)) {
      throw new Error('Tax was charged, but the account for tax owed on sales is not set (Finance → Sales posting).');
    }
    return { sales: sales.accountId, outputTax: s.outputTaxAccountId, serviceCharge };
  }

  private async submit(
    tx: Tx,
    row: FinanceSalesPostingRow,
    s: Awaited<ReturnType<SalesPostingService['settings']>>,
    p: {
      documentType: string;
      documentNo: string;
      description: string;
      branchId: string | null;
      sourceId: string;
      lines: PlannedLine[];
      /** A sale in another currency is posted in that currency, at the rate of the day (the books convert it). */
      foreign?: { currency: string; rate: string };
    },
  ): Promise<string> {
    const req: PostingRequest = {
      companyId: row.companyId,
      idempotencyKey: `sales:${row.kind}:${row.subjectId}`,
      postingDate: row.eventDate,
      documentType: p.documentType,
      documentNo: p.documentNo,
      description: p.description,
      currency: p.foreign?.currency.toUpperCase() ?? s.baseCurrency,
      rate: p.foreign?.rate ?? '1',
      rateSource: p.foreign === undefined ? 'base' : 'manual',
      lines: p.lines.map((l) => ({
        accountId: l.accountId,
        debit: fromCents(l.debitCents),
        credit: fromCents(l.creditCents),
        description: l.description,
        sourceLedger: l.sourceLedger ?? null,
        sourceEntryId: l.sourceEntryId ?? null,
      })),
      chainKey: p.branchId ?? 'general',
      branchId: p.branchId,
      origin: { surface: 'finance/sales-posting', action: row.kind, permissionUsed: null },
      source: { type: 'sales_posting', id: p.sourceId },
      postedBy: 'engine',
    };
    // The system may post into a soft-closed period: the sale already happened. A closed or
    // locked period still refuses, and the event waits until it is dealt with.
    const posted = await this.engine.post(req, { canPostSoftClosed: true, canPostControlAccounts: true }, tx);
    return posted.registerId;
  }

  private async postRow(tx: Tx, row: FinanceSalesPostingRow): Promise<string | null> {
    const s = await this.settings(tx, row.companyId);
    const live = s.salesGlGoLive !== null && row.eventDate >= s.salesGlGoLive;
    if (row.kind === 'rebate_credit') return await this.postRebate(tx, row, s);
    if (row.kind === 'credit_payment') return await this.postCreditPayment(tx, row, s);
    if (row.kind === 'wallet_use') return await this.postWalletUse(tx, row, s);
    if (row.kind === 'gift_card_issue' || row.kind === 'gift_card_adjust') return await this.postGiftCard(tx, row, s);
    if (row.kind === 'loyalty_change') return await this.postLoyalty(tx, row, s);
    if (row.kind === 'fx_application' || row.kind === 'fx_unapplication') return await this.postExchangeDifference(tx, row, s);
    const [order] = await tx.select().from(orders).where(eq(orders.id, row.subjectId));
    if (!order) throw new Error(`Order ${row.subjectId} no longer exists.`);
    const foreign = await this.foreignOf(tx, row, s, order.currency, live);
    const figures = { totalCents: toCents(order.totalAmount), taxCents: toCents(order.tax), shippingCents: toCents(order.shippingFee) };
    const group = await this.groupFor(tx, order.tradeCustomerId, s.defaultCustomerGroup);
    const label = order.orderNumber;

    if (row.kind === 'invoice') {
      if (!live) return null;
      const accounts = await this.saleAccounts(row.companyId, s, group, row.eventDate, figures);
      const receivables = (await this.setup.resolveCustomer(row.companyId, group, 'receivables')).accountId;
      return await this.submit(tx, row, s, {
        documentType: 'sales_invoice',
        documentNo: label,
        description: `Credit invoice ${label}`,
        branchId: order.branchId,
        sourceId: order.id,
        lines: creditInvoiceLines(figures, { ...accounts, receivables }, label),
        foreign,
      });
    }

    // Cash sale: settled at payment, by the payment method's account and/or gift card / points.
    const { lines: settled, carried } = await this.settle(tx, row, s, order, figures.totalCents, group, 'cash_sale', live);
    if (!live) return null;
    const accounts = await this.saleAccounts(row.companyId, s, group, row.eventDate, figures);
    const registerId = await this.submit(tx, row, s, {
      documentType: 'cash_sale',
      documentNo: label,
      description: `Cash sale ${label}`,
      branchId: order.branchId,
      sourceId: order.id,
      lines: cashSaleLines(figures, accounts, settled, label),
      foreign,
    });
    await this.postTenderDifference(tx, row, s, group, label, foreign, carried, order.branchId);
    return registerId;
  }

  /**
   * How an order's money arrived: gift cards and loyalty points first (what was tendered), the rest
   * through the payment method's bank account, whose bank ledger entry is written here whether or
   * not the general ledger is live. Returns the debit lines for the books.
   */
  private async settle(
    tx: Tx,
    row: FinanceSalesPostingRow,
    s: Awaited<ReturnType<SalesPostingService['settings']>>,
    order: typeof orders.$inferSelect,
    amountCents: number,
    group: string,
    documentType: string,
    live: boolean,
  ): Promise<{ lines: { accountId: string; cents: number; description: string }[]; carried: TenderCarry[] }> {
    const label = order.orderNumber;
    const tenders = await tx.select().from(orderTenders).where(eq(orderTenders.orderId, order.id));
    let gift = 0;
    let points = 0;
    let wallet = 0;
    for (const t of tenders) {
      if (t.kind === 'gift_card') gift += toCents(t.amount);
      else if (t.kind === 'wallet') wallet += toCents(t.amount);
      else points += toCents(t.amount);
    }
    // A payment can be smaller than the order (part was tendered earlier); tenders count first.
    gift = Math.min(gift, amountCents);
    points = Math.min(points, amountCents - gift);
    wallet = Math.min(wallet, amountCents - gift - points);
    const bankCents = amountCents - gift - points - wallet;
    const isForeign = order.currency.toUpperCase() !== s.baseCurrency;
    const carried: TenderCarry[] = [];
    const settled: { accountId: string; cents: number; description: string }[] = [];
    if (bankCents > 0) {
      const find = (branchOnly: boolean) =>
        tx
          .select({ bankId: bankAccounts.id, gl: paymentMethods.glAccountId, name: paymentMethods.name })
          .from(paymentMethods)
          .innerJoin(bankAccounts, eq(bankAccounts.id, paymentMethods.balancingBankAccountId))
          .innerJoin(paymentProviderConfigs, eq(paymentProviderConfigs.id, paymentMethods.providerId))
          .where(
            and(
              eq(paymentMethods.companyId, row.companyId),
              // Money in another currency goes into an account that holds it.
              isForeign ? eq(bankAccounts.currency, order.currency.toUpperCase()) : undefined,
              has(order.paymentMethodId)
                ? eq(paymentMethods.id, order.paymentMethodId)
                : sql`(${paymentMethods.legacyCodes} ? ${order.paymentMethod} OR ${paymentProviderConfigs.providerCode} = ${order.paymentMethod})`,
              !has(order.paymentMethodId) && branchOnly ? sql`(${paymentMethods.branchId} IS NULL OR ${paymentMethods.branchId} = ${order.branchId}::uuid)` : undefined,
            ),
          )
          // The order's own branch first, then every branch, then (so an old order still posts) any branch.
          .orderBy(sql`(${paymentMethods.branchId} IS NULL) ASC`, sql`(${paymentProviderConfigs.providerCode} = ${order.paymentMethod}) DESC`, paymentMethods.sortOrder)
          .limit(1);
      const [m] = (await find(true))[0] ? await find(true) : await find(false);
      if (!m) {
        throw new Error(
          isForeign
            ? `No payment method pays into an account that holds ${order.currency} (order ${label}). Add a bank account in ${order.currency} and a payment method for it under Settings → Payments.`
            : `No payment method stands for "${order.paymentMethod}" (order ${label}). Add a payment method for it under Settings → Payments.`,
        );
      }
      await tx.insert(bankLedgerEntries).values({
        companyId: row.companyId,
        bankAccountId: m.bankId,
        glAccountId: m.gl,
        postingDate: row.eventDate,
        documentType,
        documentNo: label,
        description: `${documentType === 'cash_sale' ? 'Sale' : 'Payment'} ${label} — ${m.name}`,
        amount: fromCents(bankCents),
        currency: order.currency.toUpperCase(),
      });
      settled.push({ accountId: m.gl, cents: bankCents, description: `Received for ${label}` });
    }
    if (live && gift > 0) {
      const accountId = (await this.setup.resolveCustomer(row.companyId, group, 'gift_card_liability')).accountId;
      settled.push({ accountId, cents: gift, description: `Gift card for ${label}` });
      if (isForeign) carried.push({ accountId, cents: gift, base: await this.carriedByCards(tx, order.id, gift) });
    }
    if (live && wallet > 0) {
      const accountId = (await this.setup.resolveCustomer(row.companyId, group, 'customer_deposits')).accountId;
      settled.push({ accountId, cents: wallet, description: `Wallet for ${label}` });
      if (isForeign) carried.push({ accountId, cents: wallet, base: await this.carriedByWallet(tx, order.id, wallet) });
    }
    if (live && points > 0) {
      const accountId = (await this.setup.resolveCustomer(row.companyId, group, 'loyalty_provision')).accountId;
      settled.push({ accountId, cents: points, description: `Loyalty points for ${label}` });
      if (isForeign) carried.push({ accountId, cents: points, base: await this.carriedByPoints(tx, order.id, points) });
    }
    return { lines: settled, carried };
  }

  /** What the cards that paid an order were carried at in the books: each card at its own rate, scaled to what counted. */
  private async carriedByCards(tx: Tx, orderId: string, counted: number): Promise<bigint> {
    const rows = await tx.select({ amount: orderTenders.amount, rate: giftCards.rate }).from(orderTenders).innerJoin(giftCards, eq(giftCards.id, sql`${orderTenders.reference}::uuid`)).where(and(eq(orderTenders.orderId, orderId), eq(orderTenders.kind, 'gift_card')));
    let total = 0n;
    let raw = 0;
    for (const r of rows) {
      total += baseValue(r.amount, r.rate);
      raw += toCents(r.amount);
    }
    return raw === counted || raw === 0 ? total : (total * BigInt(counted)) / BigInt(raw);
  }

  /** What the points that paid an order were worth in the books' currency when they were spent, scaled to what counted. */
  private async carriedByPoints(tx: Tx, orderId: string, counted: number): Promise<bigint> {
    const rows = await tx.select({ amount: orderTenders.amount, base: orderTenders.baseAmount }).from(orderTenders).where(and(eq(orderTenders.orderId, orderId), eq(orderTenders.kind, 'loyalty_points')));
    let total = 0n;
    let raw = 0;
    for (const r of rows) {
      total += parseAmount(orElse(r.base, '0'));
      raw += toCents(r.amount);
    }
    return raw === counted || raw === 0 ? total : (total * BigInt(counted)) / BigInt(raw);
  }

  /** The same for the wallet: what its tender entries took out of the books' value of the wallet, scaled to what counted. */
  private async carriedByWallet(tx: Tx, orderId: string, counted: number): Promise<bigint> {
    const rows = await tx.select({ amount: walletEntries.amount, base: walletEntries.baseAmount }).from(walletEntries).where(and(eq(walletEntries.sourceType, 'order'), eq(walletEntries.sourceId, orderId), eq(walletEntries.entryType, 'tender')));
    let total = 0n;
    let raw = 0;
    for (const r of rows) {
      total += -parseAmount(r.base);
      raw += -toCents(r.amount);
    }
    return raw === counted || raw === 0 ? total : (total * BigInt(counted)) / BigInt(raw);
  }

  /**
   * An order in another currency paid with a card or wallet: the sale took the liability down at the day's rate, but the books
   * carried it at the rate it came in at. The difference is an exchange gain or loss, booked in its own entry beside the sale.
   */
  private async postTenderDifference(tx: Tx, row: FinanceSalesPostingRow, s: Awaited<ReturnType<SalesPostingService['settings']>>, group: string, label: string, foreign: { currency: string; rate: string } | undefined, carried: readonly TenderCarry[], branchId: string | null): Promise<void> {
    if (foreign === undefined || carried.length === 0) return;
    const lines: { accountId: string; debit: string; credit: string; description: string }[] = [];
    const [gain, loss] = await Promise.all([this.setup.resolveCustomer(row.companyId, group, 'fx_gain'), this.setup.resolveCustomer(row.companyId, group, 'fx_loss')]);
    for (const c of carried) {
      // Positive: the sale took more off the liability than was booked for it.
      const diff = baseValue(fromCents(c.cents), foreign.rate) - c.base;
      if (diff === 0n) continue;
      const over = diff > 0n;
      const amount = formatAmount(over ? diff : -diff);
      lines.push(
        { accountId: over ? loss.accountId : c.accountId, debit: amount, credit: '0', description: over ? `Exchange loss on ${label}` : `Liability released for ${label}` },
        { accountId: over ? c.accountId : gain.accountId, debit: '0', credit: amount, description: over ? `Liability put back for ${label}` : `Exchange gain on ${label}` },
      );
    }
    if (lines.length === 0) return;
    await this.engine.post(
      { companyId: row.companyId, idempotencyKey: `sales:${row.kind}:${row.subjectId}:tender-fx`, postingDate: row.eventDate, documentType: 'fx_settlement', documentNo: `FXT-${label}`, description: `Exchange difference on what paid ${label}`, currency: s.baseCurrency, rate: '1', rateSource: 'base', lines, chainKey: branchId ?? 'general', branchId, origin: { surface: 'finance/sales-posting', action: row.kind, permissionUsed: null }, source: { type: 'sales_posting', id: `${row.subjectId}:tender-fx` }, postedBy: 'engine' },
      { canPostSoftClosed: true, canPostControlAccounts: true },
      tx,
    );
  }

  /** A credit customer's invoice paid through a gateway or tender: money in, debt out. */
  private async postCreditPayment(tx: Tx, row: FinanceSalesPostingRow, s: Awaited<ReturnType<SalesPostingService['settings']>>): Promise<string | null> {
    const [entry] = await tx.select().from(customerLedgerEntries).where(eq(customerLedgerEntries.id, row.subjectId));
    if (!has(entry?.orderId)) throw new Error('The payment no longer exists.');
    const [order] = await tx.select().from(orders).where(eq(orders.id, entry.orderId));
    if (!order) throw new Error(`Order ${entry.orderId} no longer exists.`);
    const live = s.salesGlGoLive !== null && row.eventDate >= s.salesGlGoLive;
    const foreign = await this.foreignOf(tx, row, s, order.currency, live);
    const group = await this.groupFor(tx, entry.customerId, s.defaultCustomerGroup);
    const cents = -toCents(entry.amount);
    const { lines: settled, carried } = await this.settle(tx, row, s, order, cents, group, 'customer_payment', live);
    if (!live) return null;
    const receivables = (await this.setup.resolveCustomer(row.companyId, group, 'receivables')).accountId;
    const lines: PlannedLine[] = [
      ...settled.map((x) => ({ accountId: x.accountId, debitCents: x.cents, creditCents: 0, description: x.description })),
      { accountId: receivables, debitCents: 0, creditCents: cents, description: `Payment ${entry.documentNo}`, sourceLedger: 'customer', sourceEntryId: entry.customerId },
    ];
    const registerId = await this.submit(tx, row, s, {
      documentType: 'customer_payment',
      documentNo: entry.documentNo,
      description: `Payment for ${order.orderNumber}`,
      branchId: order.branchId,
      sourceId: order.id,
      lines,
      foreign,
    });
    await this.postTenderDifference(tx, row, s, group, order.orderNumber, foreign, carried, order.branchId);
    return registerId;
  }

  /**
   * An order in another currency is posted in that currency at the rate of the day it happened. No rate for the day is a problem
   * to fix (the event waits, says which rate, and posts once it is set); gift cards, points and wallets only exist in the
   * books' currency, so they cannot pay for it.
   */
  private async foreignOf(tx: Tx, row: FinanceSalesPostingRow, s: Awaited<ReturnType<SalesPostingService['settings']>>, currency: string, live: boolean): Promise<{ currency: string; rate: string } | undefined> {
    if (currency.toUpperCase() === s.baseCurrency) return undefined;
    if (!live) return { currency: currency.toUpperCase(), rate: '1' };
    return { currency: currency.toUpperCase(), rate: await this.fx.requireRate(tx, row.companyId, currency, row.eventDate) };
  }

  /** A customer's wallet paying an invoice: what is owed to them goes down, so does what they owe. */
  private async postWalletUse(tx: Tx, row: FinanceSalesPostingRow, s: Awaited<ReturnType<SalesPostingService['settings']>>): Promise<string | null> {
    const live = s.salesGlGoLive !== null && row.eventDate >= s.salesGlGoLive;
    if (!live) return null;
    const [e] = await tx.select().from(walletEntries).where(eq(walletEntries.id, Number(row.subjectId)));
    if (!e) throw new Error('The wallet entry no longer exists.');
    // A wallet in another currency pays at the rate it is carried at, so what was owed to the customer leaves the books at what
    // it was booked for; the receivable it pays is carried at that same rate, and the difference to the invoice's rate is settled
    // when the payment is applied.
    const foreign = e.currency.toUpperCase() === s.baseCurrency ? undefined : { currency: e.currency.toUpperCase(), rate: e.rate };
    const group = await this.groupFor(tx, e.customerId, s.defaultCustomerGroup);
    const [deposits, receivables] = await Promise.all([
      this.setup.resolveCustomer(row.companyId, group, 'customer_deposits'),
      this.setup.resolveCustomer(row.companyId, group, 'receivables'),
    ]);
    const cents = -toCents(e.amount);
    return await this.submit(tx, row, s, {
      documentType: 'wallet_use',
      documentNo: `WAL-${e.id}`,
      description: `Wallet used (${group})`,
      branchId: null,
      sourceId: String(e.id),
      foreign,
      lines: [
        { accountId: deposits.accountId, debitCents: cents, creditCents: 0, description: 'Customer deposits used', sourceLedger: 'wallet', sourceEntryId: e.customerId },
        { accountId: receivables.accountId, debitCents: 0, creditCents: cents, description: 'Paid from wallet', sourceLedger: 'customer', sourceEntryId: e.customerId },
      ],
    });
  }

  /**
   * A gift card made, or its value changed by hand: the business owes the holder. A card that was sold is money in (through the
   * payment method it was paid with); one given away is a cost. The card's code is a secret and is never written into the books.
   */
  private async postGiftCard(tx: Tx, row: FinanceSalesPostingRow, s: Awaited<ReturnType<SalesPostingService['settings']>>): Promise<string | null> {
    const live = s.salesGlGoLive !== null && row.eventDate >= s.salesGlGoLive;
    if (!live) return null;
    const [entry] = await tx.select().from(giftCardLedger).where(eq(giftCardLedger.id, row.subjectId));
    if (!entry) throw new Error('The gift card entry no longer exists.');
    const [card] = await tx.select().from(giftCards).where(eq(giftCards.id, entry.cardId));
    if (!card) throw new Error('The gift card no longer exists.');
    const label = `GC-${card.id.slice(0, 8).toUpperCase()}`;
    // A card in another currency is carried at the rate it was issued at, every time it moves.
    const foreign = card.currency.toUpperCase() === s.baseCurrency ? undefined : { currency: card.currency.toUpperCase(), rate: card.rate };
    const group = await this.groupFor(tx, card.customerId, s.defaultCustomerGroup);
    const liability = (await this.setup.resolveCustomer(row.companyId, group, 'gift_card_liability')).accountId;
    const signed = toCents(entry.amount);
    const cents = Math.abs(signed);
    let lines: PlannedLine[];
    if (signed < 0) {
      const income = (await this.setup.resolveCustomer(row.companyId, group, 'credit_forfeit')).accountId;
      lines = [
        { accountId: liability, debitCents: cents, creditCents: 0, description: `Gift card ${label} value taken off` },
        { accountId: income, debitCents: 0, creditCents: cents, description: `Gift card ${label} value taken off` },
      ];
    } else if (entry.kind === 'issue' && card.fundedBy === 'sold') {
      if (!has(card.fundingMethodId)) throw new Error(`Gift card ${label} was sold, but not through a payment method. Say how it was paid for.`);
      const [m] = await tx
        .select({ bankId: bankAccounts.id, gl: paymentMethods.glAccountId, name: paymentMethods.name, currency: bankAccounts.currency })
        .from(paymentMethods)
        .innerJoin(bankAccounts, eq(bankAccounts.id, paymentMethods.balancingBankAccountId))
        .where(and(eq(paymentMethods.companyId, row.companyId), eq(paymentMethods.id, card.fundingMethodId)));
      if (!m) throw new Error(`The payment method gift card ${label} was sold through no longer exists.`);
      if (m.currency.toUpperCase() !== card.currency.toUpperCase()) throw new Error(`Gift card ${label} is in ${card.currency}, but ${m.name} pays into an account in ${m.currency}.`);
      await tx.insert(bankLedgerEntries).values({ companyId: row.companyId, bankAccountId: m.bankId, glAccountId: m.gl, postingDate: row.eventDate, documentType: 'gift_card_sale', documentNo: label, description: `Gift card ${label} sold — ${m.name}`, amount: fromCents(cents), currency: card.currency.toUpperCase() });
      lines = [
        { accountId: m.gl, debitCents: cents, creditCents: 0, description: `Received for gift card ${label}` },
        { accountId: liability, debitCents: 0, creditCents: cents, description: `Gift card ${label} sold` },
      ];
    } else if (entry.kind === 'adjust' || card.fundedBy === 'complimentary') {
      const cost = (await this.setup.resolveCustomer(row.companyId, group, 'rebate_expense')).accountId;
      lines = [
        { accountId: cost, debitCents: cents, creditCents: 0, description: `Gift card ${label} given free` },
        { accountId: liability, debitCents: 0, creditCents: cents, description: `Gift card ${label} given free` },
      ];
    } else {
      throw new Error(`Say how gift card ${label} was paid for (sold, or given free).`);
    }
    return await this.submit(tx, row, s, { documentType: entry.kind === 'issue' ? 'gift_card_issue' : 'gift_card_adjust', documentNo: label, description: `${entry.kind === 'issue' ? 'Gift card issued' : 'Gift card changed'} ${label}`, branchId: null, sourceId: entry.id, lines, foreign });
  }

  /** Points given, taken back, lapsed or changed by hand: what they are worth (at the value in force) is owed to the customer, at the cost of the business. */
  /**
   * A foreign payment applied to a foreign invoice: the invoice is carried at its day's rate and the payment at its own, and
   * what the two differ by is a gain or loss to the business, recognised now. Undoing an application undoes the same amount.
   */
  private async postExchangeDifference(tx: Tx, row: FinanceSalesPostingRow, s: Awaited<ReturnType<SalesPostingService['settings']>>): Promise<string | null> {
    if (s.salesGlGoLive === null || row.eventDate < s.salesGlGoLive) return null;
    const pairs = [...(await tx.execute<{ customer_id: string; invoice_id: string; credit_id: string; amount: string; currency: string; invoice_date: string; credit_date: string }>(sql`
      SELECT d.customer_id::text, d.ledger_entry_id::text AS invoice_id, d.applied_to_entry_id::text AS credit_id, d.amount::text, i.currency,
             i.posting_date::text AS invoice_date, c.posting_date::text AS credit_date
      FROM customer_detailed_entries d
      JOIN customer_ledger_entries i ON i.id = d.ledger_entry_id AND i.document_type = 'invoice'
      JOIN customer_ledger_entries c ON c.id = d.applied_to_entry_id
      WHERE d.company_id = ${row.companyId}::uuid AND d.application_id = ${row.subjectId}::uuid`))];
    if (pairs.length === 0) return null;
    const entries = pairs.flatMap((p) => [{ id: p.invoice_id, currency: p.currency, postingDate: p.invoice_date }, { id: p.credit_id, currency: p.currency, postingDate: p.credit_date }]);
    const rates = await this.fx.carryingRates(tx, row.companyId, entries);
    // Positive when the business gained: the payment is worth more than the invoice was booked at.
    const byGroup = new Map<string, bigint>();
    const groups = new Map<string, string>();
    const someone = new Map<string, string>();
    for (const p of pairs) {
      if (!groups.has(p.customer_id)) groups.set(p.customer_id, await this.groupFor(tx, p.customer_id, s.defaultCustomerGroup));
      const applied = (-toCents(p.amount)) / 100;
      const diff = baseValue(applied.toFixed(2), rates.get(p.credit_id) ?? '1') - baseValue(applied.toFixed(2), rates.get(p.invoice_id) ?? '1');
      const group = groups.get(p.customer_id) ?? s.defaultCustomerGroup;
      someone.set(group, p.customer_id);
      byGroup.set(group, (byGroup.get(group) ?? 0n) + diff);
    }
    const lines: PlannedLine[] = [];
    for (const [group, diff] of byGroup) {
      const cents = toCentsRounded(diff);
      if (cents === 0) continue;
      const [receivables, gain, loss] = await Promise.all([this.setup.resolveCustomer(row.companyId, group, 'receivables'), this.setup.resolveCustomer(row.companyId, group, 'fx_gain'), this.setup.resolveCustomer(row.companyId, group, 'fx_loss')]);
      const up = cents > 0;
      const abs = Math.abs(cents);
      lines.push(
        { accountId: up ? receivables.accountId : loss.accountId, debitCents: abs, creditCents: 0, description: up ? 'Receivables settled above their booked value' : 'Exchange loss on settlement', ...(up ? { sourceLedger: 'customer' as const, sourceEntryId: someone.get(group) } : {}) },
        { accountId: up ? gain.accountId : receivables.accountId, debitCents: 0, creditCents: abs, description: up ? 'Exchange gain on settlement' : 'Receivables settled below their booked value', ...(up ? {} : { sourceLedger: 'customer' as const, sourceEntryId: someone.get(group) }) },
      );
    }
    if (lines.length === 0) return null;
    return await this.submit(tx, row, s, {
      documentType: 'fx_settlement',
      documentNo: `FX-${row.subjectId.slice(0, 8)}`,
      description: row.kind === 'fx_application' ? 'Exchange difference on a payment' : 'Exchange difference undone',
      branchId: null,
      sourceId: row.subjectId,
      lines,
    });
  }

  private async postLoyalty(tx: Tx, row: FinanceSalesPostingRow, s: Awaited<ReturnType<SalesPostingService['settings']>>): Promise<string | null> {
    const live = s.salesGlGoLive !== null && row.eventDate >= s.salesGlGoLive;
    if (!live) return null;
    const [entry] = await tx.select().from(loyaltyLedger).where(eq(loyaltyLedger.id, row.subjectId));
    if (!entry) throw new Error('The loyalty entry no longer exists.');
    const [program] = await tx.select({ pointValue: loyaltyPrograms.pointValue }).from(loyaltyPrograms).where(eq(loyaltyPrograms.companyId, row.companyId));
    if (!program) throw new Error('There is no loyalty programme, so the points cannot be valued.');
    const cents = Math.round(Math.abs(entry.points) * Number(program.pointValue) * 100);
    if (cents === 0) return null;
    const group = await this.groupFor(tx, entry.customerId, s.defaultCustomerGroup);
    const [provision, cost] = await Promise.all([this.setup.resolveCustomer(row.companyId, group, 'loyalty_provision'), this.setup.resolveCustomer(row.companyId, group, 'rebate_expense')]);
    const given = entry.points > 0;
    const words = given ? 'Loyalty points given' : { expire: 'Loyalty points lapsed' }[entry.kind as string] ?? 'Loyalty points taken back';
    return await this.submit(tx, row, s, {
      documentType: 'loyalty_change',
      documentNo: `LOY-${entry.id.slice(0, 8).toUpperCase()}`,
      description: `${words} (${String(Math.abs(entry.points))} points)`,
      branchId: null,
      sourceId: entry.id,
      lines: [
        { accountId: given ? cost.accountId : provision.accountId, debitCents: cents, creditCents: 0, description: words, sourceLedger: given ? undefined : 'customer', sourceEntryId: given ? undefined : entry.customerId },
        { accountId: given ? provision.accountId : cost.accountId, debitCents: 0, creditCents: cents, description: words },
      ],
    });
  }

  private async postRebate(tx: Tx, row: FinanceSalesPostingRow, s: Awaited<ReturnType<SalesPostingService['settings']>>): Promise<string | null> {
    const [entry] = await tx.select().from(customerLedgerEntries).where(eq(customerLedgerEntries.id, row.subjectId));
    if (!entry) throw new Error('The rebate credit no longer exists.');
    const live = s.salesGlGoLive !== null && row.eventDate >= s.salesGlGoLive;
    if (!live) return null;
    const group = await this.groupFor(tx, entry.customerId, s.defaultCustomerGroup);
    const expense = (await this.setup.resolveCustomer(row.companyId, group, 'rebate_expense')).accountId;
    const receivables = (await this.setup.resolveCustomer(row.companyId, group, 'receivables')).accountId;
    return await this.submit(tx, row, s, {
      documentType: 'rebate_credit',
      documentNo: entry.documentNo,
      description: entry.description ?? `Rebate ${entry.documentNo}`,
      branchId: null,
      sourceId: entry.id,
      lines: rebateLines(-toCents(entry.amount), expense, receivables, entry.documentNo),
    });
  }

  // ── what people see and do ──────────────────────────────────────────────

  async backlog(companyId: string) {
    const rows = await this.db.execute<{ status: string; n: number; oldest: string | null }>(sql`
      SELECT status, count(*)::int AS n, min(created_at)::text AS oldest
      FROM finance_sales_postings WHERE company_id = ${companyId}::uuid AND status IN ('pending','failed')
      GROUP BY status`);
    const by = Object.fromEntries([...rows].map((r) => [r.status, { count: r.n, oldest: r.oldest }]));
    return { pending: by.pending?.count ?? 0, failed: by.failed?.count ?? 0, oldest: by.failed?.oldest ?? by.pending?.oldest ?? null };
  }

  async list(companyId: string, status: 'open' | 'posted' = 'open', limit = 100) {
    return await this.db
      .select()
      .from(financeSalesPostings)
      .where(
        and(
          eq(financeSalesPostings.companyId, companyId),
          status === 'open' ? inArray(financeSalesPostings.status, ['pending', 'failed']) : eq(financeSalesPostings.status, 'posted'),
        ),
      )
      .orderBy(desc(financeSalesPostings.createdAt))
      .limit(limit);
  }

  /** Try again now (after fixing the setup), for one event or every failed one. */
  async retry(ctx: FinanceContext, id?: string): Promise<{ posted: number; failed: number }> {
    await this.db
      .update(financeSalesPostings)
      .set({ nextAttemptAt: sql`now()` })
      .where(
        and(
          eq(financeSalesPostings.companyId, ctx.companyId),
          has(id) ? eq(financeSalesPostings.id, id) : eq(financeSalesPostings.status, 'failed'),
          inArray(financeSalesPostings.status, ['pending', 'failed']),
        ),
      );
    await this.decisions.record({
      companyId: ctx.companyId,
      subject: { type: 'sales_posting', id: id ?? 'all' },
      action: 'finance.sales_posting_retried',
      actor: ctx.actor,
      inputs: { origin: ctx.origin },
    });
    return await this.processDue(500);
  }

  /** Is everything in place for sales to post? Each check names what to fix. */
  async readiness(companyId: string): Promise<ReadinessCheck[]> {
    const [s] = await this.db.select().from(financeSettings).where(eq(financeSettings.companyId, companyId));
    const checks: ReadinessCheck[] = [];
    const add = (key: string, label: string, ok: boolean, detail: string, blocking = true) => checks.push({ key, label, ok, detail, blocking });
    if (!s) {
      add('finance', 'Finance is set up', false, 'Apply a chart of accounts first.');
      return checks;
    }
    add('finance', 'Finance is set up', true, `Chart: ${s.chartTemplate ?? 'custom'}, base currency ${s.baseCurrency}.`);
    const today = businessDate();
    const [period] = await this.db
      .select({ status: accountingPeriods.status })
      .from(accountingPeriods)
      .where(and(eq(accountingPeriods.companyId, companyId), sql`${accountingPeriods.startsOn} <= ${today}::date AND ${accountingPeriods.endsOn} >= ${today}::date`));
    add('period', 'Today falls in an open accounting period', period?.status === 'open', period ? `The period is ${period.status}.` : 'No fiscal period covers today. Create the fiscal year.');
    const [tax] = has(s.outputTaxAccountId)
      ? await this.db.select({ no: glAccounts.no, name: glAccounts.name }).from(glAccounts).where(eq(glAccounts.id, s.outputTaxAccountId))
      : [];
    add('tax', 'An account is set for tax owed on sales', Boolean(tax), tax ? `${tax.no} ${tax.name}` : 'Choose it below.');
    for (const [purpose, label] of [
      ['receivables', 'Customers who buy on credit have a receivables account'],
      ['service_charge', 'Shipping income has an account'],
      ['rebate_expense', 'Rebates have a cost account'],
      ['gift_card_liability', 'Gift cards have a liability account'],
      ['loyalty_provision', 'Loyalty points have a liability account'],
      ['customer_deposits', 'Customer wallets have a liability account'],
    ] as const) {
      let ok = true;
      let detail = `Group ${s.defaultCustomerGroup}.`;
      try {
        await this.setup.resolveCustomer(companyId, s.defaultCustomerGroup, purpose);
      } catch (e) {
        ok = false;
        detail = e instanceof Error ? e.message : 'Missing.';
      }
      add(`cust_${purpose}`, label, ok, detail, purpose === 'receivables');
    }
    let salesOk = true;
    let salesDetail = `${s.defaultBusinessGroup} × ${s.defaultProductGroup}.`;
    try {
      await this.setup.resolveGeneral(companyId, s.defaultBusinessGroup, s.defaultProductGroup, 'sales', today);
    } catch (e) {
      salesOk = false;
      salesDetail = e instanceof Error ? e.message : 'Missing.';
    }
    add('sales', 'Sales have an income account', salesOk, salesDetail);
    let returnsOk = true;
    let returnsDetail = 'Credit notes post to it.';
    try {
      await this.setup.resolveGeneral(companyId, s.defaultBusinessGroup, s.defaultProductGroup, 'sales_returns', today);
    } catch (e) {
      returnsOk = false;
      returnsDetail = e instanceof Error ? e.message : 'Missing.';
    }
    add('returns', 'Credit notes have a sales-returns account (a credit note cannot be issued without it once live)', returnsOk, returnsDetail);
    const [{ n }] = (await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(paymentMethods)
      .where(and(eq(paymentMethods.companyId, companyId), eq(paymentMethods.enabled, true)))) as [{ n: number }];
    add('methods', 'Payment methods are set up (cash sales need one)', n > 0, n > 0 ? `${n} on.` : 'Add them under Payment Setup.');
    return checks;
  }

  /** What customers owe in total (net of unapplied receipts), by customer posting group. */
  async openingFigures(companyId: string, valueAt?: string) {
    const [s] = await this.db.select().from(financeSettings).where(eq(financeSettings.companyId, companyId));
    if (!s) return [];
    const rows = await this.db.execute<{ grp: string; net: string; foreign: number }>(sql`
      SELECT COALESCE(c.posting_group_code, ${s.defaultCustomerGroup}) AS grp,
             COALESCE(SUM(e.remaining_amount) FILTER (WHERE upper(e.currency) = ${s.baseCurrency}), 0)::text AS net,
             count(*) FILTER (WHERE upper(e.currency) <> ${s.baseCurrency} AND e.remaining_amount <> 0)::int AS foreign
      FROM customer_ledger_entries e JOIN customers c ON c.id = e.customer_id
      WHERE e.company_id = ${companyId}::uuid AND e.remaining_amount <> 0
      GROUP BY 1`);
    const figures = new Map([...rows].map((r) => [r.grp, { group: r.grp, netCents: toCents(r.net), foreignEntries: r.foreign }]));
    // Balances in another currency count in the books' currency: at the rate each is carried at (or, for go-live, at the day's rate), plus any revaluation still standing.
    const open = [...(await this.db.execute<{ id: string; remaining: string; currency: string; posting_date: string; grp: string }>(sql`
      SELECT e.id::text, e.remaining_amount::text AS remaining, e.currency, e.posting_date::text, COALESCE(c.posting_group_code, ${s.defaultCustomerGroup}) AS grp
      FROM customer_ledger_entries e JOIN customers c ON c.id = e.customer_id
      WHERE e.company_id = ${companyId}::uuid AND e.remaining_amount <> 0 AND upper(e.currency) <> ${s.baseCurrency}`))];
    if (open.length > 0) {
      const rates = await this.fx.carryingRates(this.db, companyId, open.map((o) => ({ id: o.id, currency: o.currency, postingDate: o.posting_date })), valueAt, valueAt === undefined);
      for (const o of open) {
        if (!rates.has(o.id)) continue;
        const f = figures.get(o.grp) ?? { group: o.grp, netCents: 0, foreignEntries: 0 };
        f.netCents += toCentsRounded(baseValue(o.remaining, rates.get(o.id) ?? '1'));
        figures.set(o.grp, f);
      }
    }
    if (valueAt === undefined) {
      for (const [group, v] of await this.fx.outstandingByGroup(this.db, companyId)) {
        const f = figures.get(group) ?? { group, netCents: 0, foreignEntries: 0 };
        f.netCents += toCentsRounded(v);
        figures.set(group, f);
      }
    }
    return [...figures.values()];
  }

  /**
   * Switches sales on for the general ledger, from today. In the same step it brings in what
   * customers owe today as an opening balance, against an equity account you choose, so the
   * ledger and the customer accounts start in agreement. Done once.
   */
  async goLive(ctx: FinanceContext, input: { offsetAccountId: string }): Promise<{ date: string; opening: { group: string; amount: string }[] }> {
    const checks = await this.readiness(ctx.companyId);
    const blocking = checks.filter((c) => c.blocking && !c.ok);
    if (blocking.length > 0) {
      throw new FinanceError('NOT_READY', `Not ready: ${blocking.map((b) => b.label).join('; ')}.`);
    }
    return await this.db.transaction(async (tx) => {
      const [s] = await tx.select().from(financeSettings).where(eq(financeSettings.companyId, ctx.companyId)).for('update');
      if (!s) throw new FinanceError('FINANCE_NOT_SET_UP', 'Finance has not been set up yet.');
      if (has(s.salesGlGoLive)) throw new FinanceError('ALREADY_LIVE', `Sales have posted to the general ledger since ${s.salesGlGoLive}.`);
      const [offset] = await tx.select().from(glAccounts).where(and(eq(glAccounts.companyId, ctx.companyId), eq(glAccounts.id, input.offsetAccountId)));
      if (offset?.type !== 'posting' || offset.blocked) throw new FinanceError('OFFSET_INVALID', 'Choose a postable equity account for the opening balance.');
      if (offset.category !== 'equity') throw new FinanceError('OFFSET_INVALID', `${offset.no} ${offset.name} is not an equity account.`);
      const today = businessDate();
      const figures = (await this.openingFigures(ctx.companyId, today)).filter((f) => f.netCents !== 0);
      const opening: { group: string; amount: string }[] = [];
      for (const f of figures) {
        const receivables = (await this.setup.resolveCustomer(ctx.companyId, f.group, 'receivables')).accountId;
        const abs = Math.abs(f.netCents);
        const debit = f.netCents > 0;
        await this.engine.post(
          {
            companyId: ctx.companyId,
            idempotencyKey: `opening-receivables:${f.group}`,
            postingDate: today,
            documentType: 'opening_balance',
            documentNo: `OPEN-AR-${f.group}`,
            description: `Opening receivables (${f.group}) at go-live`,
            currency: s.baseCurrency,
            rate: '1',
            rateSource: 'base',
            lines: [
              { accountId: receivables, debit: debit ? fromCents(abs) : '0', credit: debit ? '0' : fromCents(abs), description: 'Opening customer balances', sourceLedger: 'customer' },
              { accountId: offset.id, debit: debit ? '0' : fromCents(abs), credit: debit ? fromCents(abs) : '0', description: 'Opening balance equity' },
            ],
            chainKey: 'general',
            origin: ctx.origin,
            source: { type: 'go_live', id: ctx.companyId },
            postedBy: 'engine',
          },
          { canPostSoftClosed: true, canPostControlAccounts: true },
          tx,
        );
        opening.push({ group: f.group, amount: fromCents(f.netCents) });
      }
      // What customers already hold in their wallets is owed to them: it comes in as a liability.
      // A wallet in another currency is valued at the rate of today, from here on its carrying value.
      const wallets = await tx.execute<{ id: string; grp: string; currency: string; balance: string }>(sql`
        SELECT w.id::text, COALESCE(c.posting_group_code, ${s.defaultCustomerGroup}) AS grp, w.currency, w.balance::text
        FROM customer_wallets w JOIN customers c ON c.id = w.customer_id
        WHERE w.company_id = ${ctx.companyId}::uuid AND w.balance > 0`);
      const heldCents = new Map<string, number>();
      for (const w of wallets) {
        let cents = toCents(w.balance);
        if (w.currency.toUpperCase() !== s.baseCurrency) {
          const value = baseValue(w.balance, await this.fx.requireRate(tx, ctx.companyId, w.currency, today));
          cents = toCentsRounded(value);
          await tx.execute(sql`UPDATE customer_wallets SET base_value = ${formatAmount(value)}::numeric WHERE id = ${w.id}::uuid`);
        }
        heldCents.set(w.grp, (heldCents.get(w.grp) ?? 0) + cents);
      }
      const held = [...heldCents].map(([grp, cents]) => ({ grp, total: fromCents(cents) }));
      // Refunds already approved but not yet paid are owed too (set aside before the books started).
      const pending = await tx.execute<{ id: string; grp: string; currency: string; amount: string }>(sql`
        SELECT r.id::text, COALESCE(c.posting_group_code, ${s.defaultCustomerGroup}) AS grp, r.currency, r.amount::text
        FROM refund_requests r JOIN customers c ON c.id = r.customer_id
        WHERE r.company_id = ${ctx.companyId}::uuid
          AND ((r.status = 'approved' AND r.reserve_register_id IS NULL AND r.source_kind <> 'returned_payout')
            -- money that came back before the books started is owed again, whatever stage its replacement is at
            OR (r.source_kind = 'returned_payout' AND r.status IN ('draft', 'pending_approval', 'approved')
                AND NOT EXISTS (SELECT 1 FROM refund_returns x WHERE x.id::text = r.source_id AND x.register_id IS NOT NULL)))`);
      // A refund in another currency is worth the rate of today from here on: that is the rate it is booked and paid at.
      const owedCents = new Map<string, number>();
      for (const r of pending) {
        let cents = toCents(r.amount);
        if (r.currency.toUpperCase() !== s.baseCurrency) {
          const rate = await this.fx.requireRate(tx, ctx.companyId, r.currency, today);
          cents = toCentsRounded(baseValue(r.amount, rate));
          await tx.execute(sql`UPDATE refund_requests SET rate = ${rate} WHERE id = ${r.id}::uuid`);
        }
        owedCents.set(r.grp, (owedCents.get(r.grp) ?? 0) + cents);
      }
      const owed = [...owedCents].map(([grp, cents]) => ({ grp, total: fromCents(cents) }));
      for (const o of owed) {
        const payable = (await this.setup.resolveCustomer(ctx.companyId, o.grp, 'refunds_payable')).accountId;
        const cents = toCents(o.total);
        await this.engine.post(
          {
            companyId: ctx.companyId,
            idempotencyKey: `opening-refunds:${o.grp}`,
            postingDate: today,
            documentType: 'opening_balance',
            documentNo: `OPEN-RFD-${o.grp}`,
            description: `Opening refunds payable (${o.grp}) at go-live`,
            currency: s.baseCurrency,
            rate: '1',
            rateSource: 'base',
            lines: [
              { accountId: offset.id, debit: fromCents(cents), credit: '0', description: 'Opening balance equity' },
              { accountId: payable, debit: '0', credit: fromCents(cents), description: 'Opening refunds payable' },
            ],
            chainKey: 'general',
            origin: ctx.origin,
            source: { type: 'go_live', id: ctx.companyId },
            postedBy: 'engine',
          },
          { canPostSoftClosed: true, canPostControlAccounts: true },
          tx,
        );
        opening.push({ group: `${o.grp} (refunds payable)`, amount: fromCents(-cents) });
      }
      for (const h of held) {
        const deposits = (await this.setup.resolveCustomer(ctx.companyId, h.grp, 'customer_deposits')).accountId;
        const cents = toCents(h.total);
        await this.engine.post(
          {
            companyId: ctx.companyId,
            idempotencyKey: `opening-wallets:${h.grp}`,
            postingDate: today,
            documentType: 'opening_balance',
            documentNo: `OPEN-WAL-${h.grp}`,
            description: `Opening customer wallets (${h.grp}) at go-live`,
            currency: s.baseCurrency,
            rate: '1',
            rateSource: 'base',
            lines: [
              { accountId: offset.id, debit: fromCents(cents), credit: '0', description: 'Opening balance equity' },
              { accountId: deposits, debit: '0', credit: fromCents(cents), description: 'Opening customer wallets', sourceLedger: 'wallet' },
            ],
            chainKey: 'general',
            origin: ctx.origin,
            source: { type: 'go_live', id: ctx.companyId },
            postedBy: 'engine',
          },
          { canPostSoftClosed: true, canPostControlAccounts: true },
          tx,
        );
        opening.push({ group: `${h.grp} (wallets)`, amount: fromCents(-cents) });
      }
      // Gift cards with value left and points not yet spent are owed to their holders.
      // A card in another currency is carried at the rate of today from here on.
      const open = await tx.execute<{ id: string; currency: string; balance: string }>(sql`SELECT id::text, currency, balance::text FROM gift_cards WHERE company_id = ${ctx.companyId}::uuid AND balance > 0`);
      let cardCents = 0;
      for (const card of open) {
        if (card.currency.toUpperCase() === s.baseCurrency) {
          cardCents += toCents(card.balance);
          continue;
        }
        const rate = await this.fx.requireRate(tx, ctx.companyId, card.currency, today);
        cardCents += toCentsRounded(baseValue(card.balance, rate));
        await tx.execute(sql`UPDATE gift_cards SET rate = ${rate} WHERE id = ${card.id}::uuid`);
      }
      if (cardCents > 0) {
        const liability = (await this.setup.resolveCustomer(ctx.companyId, s.defaultCustomerGroup, 'gift_card_liability')).accountId;
        await this.openingLiability(tx, ctx, s, offset.id, liability, cardCents, 'opening-giftcards', 'OPEN-GIFT', 'Opening gift card balances at go-live');
        opening.push({ group: 'gift cards', amount: fromCents(-cardCents) });
      }
      const [prog] = await tx.select({ pointValue: loyaltyPrograms.pointValue }).from(loyaltyPrograms).where(eq(loyaltyPrograms.companyId, ctx.companyId));
      if (prog) {
        const pts = (await tx.execute<{ total: string }>(sql`SELECT COALESCE(SUM(balance), 0)::text AS total FROM loyalty_accounts WHERE company_id = ${ctx.companyId}::uuid AND balance > 0`))[0];
        const pointCents = Math.round(Number(pts?.total ?? 0) * Number(prog.pointValue) * 100);
        if (pointCents > 0) {
          const provision = (await this.setup.resolveCustomer(ctx.companyId, s.defaultCustomerGroup, 'loyalty_provision')).accountId;
          await this.openingLiability(tx, ctx, s, offset.id, provision, pointCents, 'opening-loyalty', 'OPEN-LOY', 'Opening loyalty points owed at go-live');
          opening.push({ group: 'loyalty points', amount: fromCents(-pointCents) });
        }
      }
      await tx.update(financeSettings).set({ salesGlGoLive: today, updatedAt: new Date() }).where(eq(financeSettings.companyId, ctx.companyId));
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'finance_settings', id: ctx.companyId },
          action: 'finance.sales_gl_go_live',
          actor: ctx.actor,
          inputs: { origin: ctx.origin, offsetAccount: offset.no },
          outcome: { date: today, opening },
        },
        tx,
      );
      return { date: today, opening };
    });
  }

  /** A liability that already existed when the books started comes in against the opening-balance equity account. */
  private async openingLiability(tx: Tx, ctx: FinanceContext, s: Awaited<ReturnType<SalesPostingService['settings']>>, offsetId: string, liabilityId: string, cents: number, key: string, documentNo: string, description: string): Promise<void> {
    await this.engine.post(
      {
        companyId: ctx.companyId,
        idempotencyKey: key,
        postingDate: businessDate(),
        documentType: 'opening_balance',
        documentNo,
        description,
        currency: s.baseCurrency,
        rate: '1',
        rateSource: 'base',
        lines: [
          { accountId: offsetId, debit: fromCents(cents), credit: '0', description: 'Opening balance equity' },
          { accountId: liabilityId, debit: '0', credit: fromCents(cents), description },
        ],
        chainKey: 'general',
        origin: ctx.origin,
        source: { type: 'go_live', id: ctx.companyId },
        postedBy: 'engine',
      },
      { canPostSoftClosed: true, canPostControlAccounts: true },
      tx,
    );
  }

  /** What is owed to gift card holders and loyalty members, in the books against the cards and accounts themselves. */
  async liabilityReconciliation(companyId: string) {
    const [s] = await this.db.select().from(financeSettings).where(eq(financeSettings.companyId, companyId));
    if (s === undefined) return [];
    if (s.salesGlGoLive === null) return [];
    const out: { label: string; accountNo: string; accountName: string; glCents: number; subLedgerCents: number; diffCents: number }[] = [];
    const net = async (accountId: string) => {
      const [bal] = await this.db.execute<{ net: string }>(sql`SELECT COALESCE(SUM(base_credit - base_debit), 0)::text AS net FROM gl_account_balances WHERE company_id = ${companyId}::uuid AND account_id = ${accountId}::uuid`);
      return toCents(Number(bal?.net ?? 0).toFixed(2));
    };
    const label = async (accountId: string) => {
      const [a] = await this.db.select({ no: glAccounts.no, name: glAccounts.name }).from(glAccounts).where(eq(glAccounts.id, accountId));
      return { no: a?.no ?? '', name: a?.name ?? '' };
    };
    try {
      const liability = (await this.setup.resolveCustomer(companyId, s.defaultCustomerGroup, 'gift_card_liability')).accountId;
      const [cards] = await this.db.execute<{ total: string }>(sql`SELECT COALESCE(SUM(balance * rate::numeric), 0)::text AS total FROM gift_cards WHERE company_id = ${companyId}::uuid`);
      const standing = [...(await this.fx.outstandingCardsByGroup(this.db, companyId)).values()].reduce((n, v) => n + v, 0n);
      const gl = await net(liability);
      const sub = toCents(Number(cards?.total ?? 0).toFixed(2)) + Math.round(Number(standing) / 100);
      const a = await label(liability);
      out.push({ label: 'Gift cards', accountNo: a.no, accountName: a.name, glCents: gl, subLedgerCents: sub, diffCents: gl - sub });
    } catch {
      // no account chosen yet: the readiness list already says so
    }
    try {
      const provision = (await this.setup.resolveCustomer(companyId, s.defaultCustomerGroup, 'loyalty_provision')).accountId;
      const [prog] = await this.db.select({ pointValue: loyaltyPrograms.pointValue }).from(loyaltyPrograms).where(eq(loyaltyPrograms.companyId, companyId));
      const [pts] = await this.db.execute<{ total: string }>(sql`SELECT COALESCE(SUM(balance), 0)::text AS total FROM loyalty_accounts WHERE company_id = ${companyId}::uuid`);
      const gl = await net(provision);
      const sub = Math.round(Number(pts?.total ?? 0) * Number(prog?.pointValue ?? 0) * 100);
      const a = await label(provision);
      out.push({ label: 'Loyalty points', accountNo: a.no, accountName: a.name, glCents: gl, subLedgerCents: sub, diffCents: gl - sub });
    } catch {
      // no account chosen yet
    }
    return out;
  }

  /** The receivables control account in the books against the customer accounts, per group. */
  async reconciliation(companyId: string) {
    const [s] = await this.db.select().from(financeSettings).where(eq(financeSettings.companyId, companyId));
    if (!s) return { live: false, rows: [], backlog: { pending: 0, failed: 0, oldest: null as string | null } };
    const groups = await this.db.execute<{ code: string; account_id: string | null; no: string | null; name: string | null }>(sql`
      SELECT g.code, g.receivables_account_id AS account_id, a.no, a.name
      FROM customer_posting_groups g LEFT JOIN gl_accounts a ON a.id = g.receivables_account_id
      WHERE g.company_id = ${companyId}::uuid`);
    const opening = new Map((await this.openingFigures(companyId)).map((f) => [f.group, f]));
    const byAccount = new Map<string, { no: string; name: string; subLedger: number; groups: string[]; foreign: number; accountId: string }>();
    for (const g of groups) {
      if (!has(g.account_id)) continue;
      const cur = byAccount.get(g.account_id) ?? { no: required(g.no, 'an account number'), name: required(g.name, 'an account name'), subLedger: 0, groups: [], foreign: 0, accountId: g.account_id };
      cur.subLedger += opening.get(g.code)?.netCents ?? 0;
      cur.foreign += opening.get(g.code)?.foreignEntries ?? 0;
      cur.groups.push(g.code);
      byAccount.set(g.account_id, cur);
    }
    const rows = [];
    for (const a of byAccount.values()) {
      const [bal] = await this.db.execute<{ net: string }>(sql`
        SELECT COALESCE(SUM(base_debit - base_credit), 0)::text AS net FROM gl_account_balances
        WHERE company_id = ${companyId}::uuid AND account_id = ${a.accountId}::uuid`);
      const gl = toCents(Number(bal?.net ?? 0).toFixed(2));
      rows.push({ accountNo: a.no, accountName: a.name, groups: a.groups, glCents: gl, subLedgerCents: a.subLedger, diffCents: gl - a.subLedger, foreignEntries: a.foreign });
    }
    return { live: s.salesGlGoLive !== null, goLive: s.salesGlGoLive, rows, backlog: await this.backlog(companyId) };
  }

  async setOutputTaxAccount(ctx: FinanceContext, accountId: string) {
    const [a] = await this.db.select().from(glAccounts).where(and(eq(glAccounts.companyId, ctx.companyId), eq(glAccounts.id, accountId)));
    if (a?.type !== 'posting' || a.blocked) throw new FinanceError('ACCOUNT_INVALID', 'Choose a postable account.');
    if (a.category !== 'liabilities') throw new FinanceError('ACCOUNT_INVALID', `${a.no} ${a.name} is not a liability account; tax owed on sales is a liability.`);
    await this.db.transaction(async (tx) => {
      await tx.update(financeSettings).set({ outputTaxAccountId: accountId, updatedAt: new Date() }).where(eq(financeSettings.companyId, ctx.companyId));
      await this.decisions.record(
        { companyId: ctx.companyId, subject: { type: 'finance_settings', id: ctx.companyId }, action: 'finance.output_tax_account_set', actor: ctx.actor, inputs: { origin: ctx.origin }, outcome: { account: a.no } },
        tx,
      );
    });
  }

  async saveCustomerGroupAccounts(ctx: FinanceContext, code: string, accounts: Partial<Record<string, string | null>>) {
    const columns: Record<string, string> = {
      receivables: 'receivables_account_id',
      customer_deposits: 'customer_deposits_account_id',
      refunds_payable: 'refunds_payable_account_id',
      payment_discount: 'payment_discount_account_id',
      write_off: 'write_off_account_id',
      rounding: 'rounding_account_id',
      fx_gain: 'fx_gain_account_id',
      fx_loss: 'fx_loss_account_id',
      service_charge: 'service_charge_account_id',
      rebate_expense: 'rebate_expense_account_id',
      gift_card_liability: 'gift_card_liability_account_id',
      loyalty_provision: 'loyalty_provision_account_id',
      credit_forfeit: 'credit_forfeit_account_id',
      credit_adjustment: 'credit_adjustment_account_id',
    };
    const sets = Object.entries(accounts).filter(([k]) => k in columns);
    if (sets.length === 0) return;
    const ids = sets.map(([, v]) => v).filter((v): v is string => Boolean(v));
    if (ids.length !== 0) {
      const found = await this.db.select({ id: glAccounts.id, type: glAccounts.type, blocked: glAccounts.blocked }).from(glAccounts).where(and(eq(glAccounts.companyId, ctx.companyId), inArray(glAccounts.id, ids)));
      if (found.length !== new Set(ids).size || found.some((a) => a.type !== 'posting' || a.blocked)) {
        throw new FinanceError('ACCOUNT_INVALID', 'Every account must exist, be postable and not be blocked.');
      }
    }
    await this.db.transaction(async (tx) => {
      const res = await tx.execute(sql`
        UPDATE customer_posting_groups SET ${sql.join(sets.map(([k, v]) => sql`${sql.raw(columns[k])} = ${v ?? null}::uuid`), sql`, `)}
        WHERE company_id = ${ctx.companyId}::uuid AND code = ${code} RETURNING id`);
      if ([...res].length === 0) throw new FinanceError('NOT_FOUND', `Customer posting group ${code} does not exist.`);
      await this.decisions.record(
        { companyId: ctx.companyId, subject: { type: 'customer_posting_group', id: code }, action: 'finance.customer_group_saved', actor: ctx.actor, inputs: { origin: ctx.origin, purposes: sets.map(([k]) => k) } },
        tx,
      );
    });
  }
}
