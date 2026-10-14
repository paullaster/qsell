import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  accountingPeriods,
  bankAccounts,
  bankLedgerEntries,
  customerLedgerEntries,
  customers,
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
    if (!customerId) return fallback;
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
    if (figures.taxCents > 0 && !s.outputTaxAccountId) {
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
    },
  ): Promise<string> {
    const req: PostingRequest = {
      companyId: row.companyId,
      idempotencyKey: `sales:${row.kind}:${row.subjectId}`,
      postingDate: row.eventDate,
      documentType: p.documentType,
      documentNo: p.documentNo,
      description: p.description,
      currency: s.baseCurrency,
      rate: '1',
      rateSource: 'base',
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
    const [order] = await tx.select().from(orders).where(eq(orders.id, row.subjectId));
    if (!order) throw new Error(`Order ${row.subjectId} no longer exists.`);
    if (order.currency.toUpperCase() !== s.baseCurrency) {
      throw new Error(
        `Order ${order.orderNumber} is in ${order.currency}; sales in a foreign currency are not posted to the general ledger yet.`,
      );
    }
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
      });
    }

    // Cash sale: settled at payment, by the payment method's account and/or gift card / points.
    const settled = await this.settle(tx, row, s, order, figures.totalCents, group, 'cash_sale', live);
    if (!live) return null;
    const accounts = await this.saleAccounts(row.companyId, s, group, row.eventDate, figures);
    return await this.submit(tx, row, s, {
      documentType: 'cash_sale',
      documentNo: label,
      description: `Cash sale ${label}`,
      branchId: order.branchId,
      sourceId: order.id,
      lines: cashSaleLines(figures, accounts, settled, label),
    });
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
  ): Promise<{ accountId: string; cents: number; description: string }[]> {
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
              order.paymentMethodId
                ? eq(paymentMethods.id, order.paymentMethodId)
                : sql`(${paymentMethods.legacyCodes} ? ${order.paymentMethod} OR ${paymentProviderConfigs.providerCode} = ${order.paymentMethod})`,
              !order.paymentMethodId && branchOnly ? sql`(${paymentMethods.branchId} IS NULL OR ${paymentMethods.branchId} = ${order.branchId}::uuid)` : undefined,
            ),
          )
          // The order's own branch first, then every branch, then (so an old order still posts) any branch.
          .orderBy(sql`(${paymentMethods.branchId} IS NULL) ASC`, sql`(${paymentProviderConfigs.providerCode} = ${order.paymentMethod}) DESC`, paymentMethods.sortOrder)
          .limit(1);
      const [m] = (await find(true))[0] ? await find(true) : await find(false);
      if (!m) {
        throw new Error(
          `No payment method stands for "${order.paymentMethod}" (order ${label}). Add a payment method for it under Settings → Payments.`,
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
        currency: s.baseCurrency,
      });
      settled.push({ accountId: m.gl, cents: bankCents, description: `Received for ${label}` });
    }
    if (live && gift > 0) {
      settled.push({ accountId: (await this.setup.resolveCustomer(row.companyId, group, 'gift_card_liability')).accountId, cents: gift, description: `Gift card for ${label}` });
    }
    if (live && wallet > 0) {
      settled.push({ accountId: (await this.setup.resolveCustomer(row.companyId, group, 'customer_deposits')).accountId, cents: wallet, description: `Wallet for ${label}` });
    }
    if (live && points > 0) {
      settled.push({ accountId: (await this.setup.resolveCustomer(row.companyId, group, 'loyalty_provision')).accountId, cents: points, description: `Loyalty points for ${label}` });
    }
    return settled;
  }

  /** A credit customer's invoice paid through a gateway or tender: money in, debt out. */
  private async postCreditPayment(tx: Tx, row: FinanceSalesPostingRow, s: Awaited<ReturnType<SalesPostingService['settings']>>): Promise<string | null> {
    const [entry] = await tx.select().from(customerLedgerEntries).where(eq(customerLedgerEntries.id, row.subjectId));
    if (!entry?.orderId) throw new Error('The payment no longer exists.');
    const [order] = await tx.select().from(orders).where(eq(orders.id, entry.orderId));
    if (!order) throw new Error(`Order ${entry.orderId} no longer exists.`);
    if (order.currency.toUpperCase() !== s.baseCurrency) {
      throw new Error(`Order ${order.orderNumber} is in ${order.currency}; payments in a foreign currency are not posted to the general ledger yet.`);
    }
    const live = s.salesGlGoLive !== null && row.eventDate >= s.salesGlGoLive;
    const group = await this.groupFor(tx, entry.customerId, s.defaultCustomerGroup);
    const cents = -toCents(entry.amount);
    const settled = await this.settle(tx, row, s, order, cents, group, 'customer_payment', live);
    if (!live) return null;
    const receivables = (await this.setup.resolveCustomer(row.companyId, group, 'receivables')).accountId;
    const lines: PlannedLine[] = [
      ...settled.map((x) => ({ accountId: x.accountId, debitCents: x.cents, creditCents: 0, description: x.description })),
      { accountId: receivables, debitCents: 0, creditCents: cents, description: `Payment ${entry.documentNo}`, sourceLedger: 'customer', sourceEntryId: entry.customerId },
    ];
    return await this.submit(tx, row, s, {
      documentType: 'customer_payment',
      documentNo: entry.documentNo,
      description: `Payment for ${order.orderNumber}`,
      branchId: order.branchId,
      sourceId: order.id,
      lines,
    });
  }

  /** A customer's wallet paying an invoice: what is owed to them goes down, so does what they owe. */
  private async postWalletUse(tx: Tx, row: FinanceSalesPostingRow, s: Awaited<ReturnType<SalesPostingService['settings']>>): Promise<string | null> {
    const live = s.salesGlGoLive !== null && row.eventDate >= s.salesGlGoLive;
    if (!live) return null;
    const [e] = await tx.select().from(walletEntries).where(eq(walletEntries.id, Number(row.subjectId)));
    if (!e) throw new Error('The wallet entry no longer exists.');
    if (e.currency.toUpperCase() !== s.baseCurrency) {
      throw new Error(`The wallet is in ${e.currency}; wallet use in a foreign currency is not posted to the general ledger yet.`);
    }
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
      lines: [
        { accountId: deposits.accountId, debitCents: cents, creditCents: 0, description: 'Customer deposits used', sourceLedger: 'wallet', sourceEntryId: e.customerId },
        { accountId: receivables.accountId, debitCents: 0, creditCents: cents, description: 'Paid from wallet', sourceLedger: 'customer', sourceEntryId: e.customerId },
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
          id ? eq(financeSalesPostings.id, id) : eq(financeSalesPostings.status, 'failed'),
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
    const [tax] = s.outputTaxAccountId
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
  async openingFigures(companyId: string) {
    const [s] = await this.db.select().from(financeSettings).where(eq(financeSettings.companyId, companyId));
    if (!s) return [];
    const rows = await this.db.execute<{ grp: string; net: string; foreign: number }>(sql`
      SELECT COALESCE(c.posting_group_code, ${s.defaultCustomerGroup}) AS grp,
             COALESCE(SUM(e.remaining_amount) FILTER (WHERE e.currency = ${s.baseCurrency}), 0)::text AS net,
             count(*) FILTER (WHERE e.currency <> ${s.baseCurrency} AND e.remaining_amount <> 0)::int AS foreign
      FROM customer_ledger_entries e JOIN customers c ON c.id = e.customer_id
      WHERE e.company_id = ${companyId}::uuid AND e.remaining_amount <> 0
      GROUP BY 1`);
    return [...rows].map((r) => ({ group: r.grp, netCents: toCents(r.net), foreignEntries: r.foreign }));
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
      if (s.salesGlGoLive) throw new FinanceError('ALREADY_LIVE', `Sales have posted to the general ledger since ${s.salesGlGoLive}.`);
      const [offset] = await tx.select().from(glAccounts).where(and(eq(glAccounts.companyId, ctx.companyId), eq(glAccounts.id, input.offsetAccountId)));
      if (!offset || offset.type !== 'posting' || offset.blocked) throw new FinanceError('OFFSET_INVALID', 'Choose a postable equity account for the opening balance.');
      if (offset.category !== 'equity') throw new FinanceError('OFFSET_INVALID', `${offset.no} ${offset.name} is not an equity account.`);
      const today = businessDate();
      const figures = (await this.openingFigures(ctx.companyId)).filter((f) => f.netCents !== 0);
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
      const held = await tx.execute<{ grp: string; total: string }>(sql`
        SELECT COALESCE(c.posting_group_code, ${s.defaultCustomerGroup}) AS grp, SUM(w.balance)::text AS total
        FROM customer_wallets w JOIN customers c ON c.id = w.customer_id
        WHERE w.company_id = ${ctx.companyId}::uuid AND w.currency = ${s.baseCurrency} AND w.balance > 0 GROUP BY 1`);
      // Refunds already approved but not yet paid are owed too (set aside before the books started).
      const owed = await tx.execute<{ grp: string; total: string }>(sql`
        SELECT COALESCE(c.posting_group_code, ${s.defaultCustomerGroup}) AS grp, SUM(r.amount)::text AS total
        FROM refund_requests r JOIN customers c ON c.id = r.customer_id
        WHERE r.company_id = ${ctx.companyId}::uuid AND r.status = 'approved' AND r.reserve_register_id IS NULL AND r.currency = ${s.baseCurrency}
        GROUP BY 1`);
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
      if (!g.account_id) continue;
      const cur = byAccount.get(g.account_id) ?? { no: g.no!, name: g.name!, subLedger: 0, groups: [], foreign: 0, accountId: g.account_id };
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
    if (!a || a.type !== 'posting' || a.blocked) throw new FinanceError('ACCOUNT_INVALID', 'Choose a postable account.');
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
    };
    const sets = Object.entries(accounts).filter(([k]) => k in columns);
    if (sets.length === 0) return;
    const ids = sets.map(([, v]) => v).filter((v): v is string => Boolean(v));
    if (ids.length) {
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
