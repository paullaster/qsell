import { and, desc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  branches,
  customerLedgerEntries,
  customers,
  orders,
  paymentAttempts,
  transactionLedgerEntries,
} from '@/server/db/drizzle/schema';
import { shownPaymentReference } from '@/lib/paymentReference';
import { TransactionLedgerService } from './ledger-service';

export type MissingInvoiceDebit = {
  orderId: string;
  orderNumber: string;
  customerName: string;
  amount: string;
  currency: string;
  paymentStatus: string;
  paymentMethod: string | null;
  customerAccountType: string | null;
  createdAt: string;
};

export type MissingPaymentCredit = {
  key: string;
  source: 'customer_ledger' | 'gateway_attempt';
  id: string;
  orderId: string | null;
  orderNumber: string | null;
  provider: string | null;
  customerName: string | null;
  documentNo: string;
  amount: string;
  currency: string;
  paidAt: string | null;
};

export type LedgerReconciliationSnapshot = {
  invoiceDebits: MissingInvoiceDebit[];
  paymentCredits: MissingPaymentCredit[];
};

function num(value: string | number | null | undefined): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value);
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Manual-only gap finder for the transaction ledger.
 *
 * Nothing here retries automatically. The admin reviews the missing documents
 * on the Reconcile screen and clicks Post. Every post goes through
 * TransactionLedgerService with the same idempotency keys the live flow uses,
 * so posting a document that later arrives is a no-op.
 */
export class TransactionReconcileService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly ledger: TransactionLedgerService,
  ) {}

  async listMissing(companyId: string, limit = 200): Promise<LedgerReconciliationSnapshot> {
    const branchIds = await this.companyBranchIds(companyId);
    const [invoiceDebits, paymentCredits] = await Promise.all([
      this.listMissingInvoiceDebits(companyId, branchIds, limit),
      this.listMissingPaymentCredits(companyId, branchIds, limit),
    ]);
    return { invoiceDebits, paymentCredits };
  }

  /** Sales (orders) that never posted their invoice debit to the transaction ledger. */
  private async listMissingInvoiceDebits(
    companyId: string,
    branchIds: string[],
    limit: number,
  ): Promise<MissingInvoiceDebit[]> {
    const rows = await this.db
      .select({
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        amount: orders.totalAmount,
        currency: orders.currency,
        paymentStatus: orders.paymentStatus,
        paymentMethod: orders.paymentMethod,
        customerAccountType: orders.customerAccountType,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .leftJoin(
        transactionLedgerEntries,
        and(
          eq(transactionLedgerEntries.orderId, orders.id),
          eq(transactionLedgerEntries.documentType, 'invoice'),
        ),
      )
      .where(
        and(
          isNull(transactionLedgerEntries.id),
          notInArray(orders.status, ['cancelled', 'failed']),
          or(isNull(orders.branchId), inArray(orders.branchId, branchIds)),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      customerName: row.customerName,
      amount: row.amount,
      currency: row.currency,
      paymentStatus: row.paymentStatus,
      paymentMethod: row.paymentMethod,
      customerAccountType: row.customerAccountType,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Payments that never posted their credit. Two sources are de-duplicated:
   * 1. customer_ledger_entries payment rows (documented receipts).
   * 2. successful gateway attempts that never produced a payment document.
   */
  private async listMissingPaymentCredits(
    companyId: string,
    branchIds: string[],
    limit: number,
  ): Promise<MissingPaymentCredit[]> {
    const fromLedger = await this.db
      .select({
        id: customerLedgerEntries.id,
        customerId: customerLedgerEntries.customerId,
        orderId: customerLedgerEntries.orderId,
        documentNo: customerLedgerEntries.documentNo,
        amount: customerLedgerEntries.amount,
        createdAt: customerLedgerEntries.createdAt,
        customerName: customers.name,
        orderNumber: orders.orderNumber,
        orderCurrency: orders.currency,
      })
      .from(customerLedgerEntries)
      .leftJoin(customers, eq(customers.id, customerLedgerEntries.customerId))
      .leftJoin(orders, eq(orders.id, customerLedgerEntries.orderId))
      .leftJoin(
        transactionLedgerEntries,
        and(
          eq(transactionLedgerEntries.documentType, 'payment'),
          eq(transactionLedgerEntries.direction, 'credit'),
          eq(transactionLedgerEntries.customerId, customerLedgerEntries.customerId),
          eq(transactionLedgerEntries.documentNo, customerLedgerEntries.documentNo),
          sql`${transactionLedgerEntries.amount} = (${customerLedgerEntries.amount} * -1.0)`,
        ),
      )
      .where(
        and(
          eq(customerLedgerEntries.documentType, 'payment'),
          eq(customerLedgerEntries.companyId, companyId),
          isNull(transactionLedgerEntries.id),
        ),
      )
      .orderBy(desc(customerLedgerEntries.createdAt))
      .limit(limit);

    const fromAttempts = await this.db
      .select({
        id: paymentAttempts.id,
        orderId: paymentAttempts.orderId,
        orderNumber: paymentAttempts.orderNumber,
        providerCode: paymentAttempts.providerCode,
        providerReference: paymentAttempts.providerReference,
        orderTransactionReference: orders.transactionReference,
        mpesaReceiptNumber: orders.mpesaReceiptNumber,
        amount: paymentAttempts.amount,
        currency: paymentAttempts.currency,
        paidAt: paymentAttempts.paidAt,
        customerName: orders.customerName,
        orderCurrency: orders.currency,
      })
      .from(paymentAttempts)
      .leftJoin(orders, eq(orders.id, paymentAttempts.orderId))
      .leftJoin(
        transactionLedgerEntries,
        and(
          eq(transactionLedgerEntries.documentType, 'payment'),
          eq(transactionLedgerEntries.direction, 'credit'),
          eq(transactionLedgerEntries.orderId, paymentAttempts.orderId),
          sql`${transactionLedgerEntries.amount} = ${paymentAttempts.amount}`,
        ),
      )
      .where(
        and(
          eq(paymentAttempts.status, 'successful'),
          isNull(transactionLedgerEntries.id),
          inArray(paymentAttempts.branchId, branchIds),
          sql`not exists (
            select 1 from ${customerLedgerEntries} cle
            where cle.order_id = ${paymentAttempts.orderId}
              and cle.document_type = 'payment'
          )`,
        ),
      )
      .orderBy(desc(paymentAttempts.paidAt))
      .limit(limit);

    const ledgers: MissingPaymentCredit[] = fromLedger.map((row) => ({
      key: `ledger:${row.id}`,
      source: 'customer_ledger',
      id: row.id,
      orderId: row.orderId ?? null,
      orderNumber: row.orderNumber ?? null,
      provider: null,
      customerName: row.customerName,
      documentNo: row.documentNo,
      amount: Math.abs(num(row.amount)).toFixed(2),
      currency: row.orderCurrency || 'KES',
      paidAt: iso(row.createdAt),
    }));

    const attempts: MissingPaymentCredit[] = fromAttempts.map((row) => ({
      key: `attempt:${row.id}`,
      source: 'gateway_attempt',
      id: row.id,
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      provider: row.providerCode,
      customerName: row.customerName,
      documentNo:
        shownPaymentReference({
          paymentMethod: row.providerCode,
          transactionReference: row.orderTransactionReference,
          mpesaReceiptNumber: row.mpesaReceiptNumber,
        }) || '',
      amount: num(row.amount).toFixed(2),
      currency: row.currency || row.orderCurrency || 'KES',
      paidAt: iso(row.paidAt),
    }));

    return [...ledgers, ...attempts].slice(0, limit);
  }

  /** Manually post a debit for an order that never hit the transaction ledger. */
  async postInvoiceDebit(companyId: string, orderId: string): Promise<void> {
    const branchIds = await this.companyBranchIds(companyId);
    const [order] = await this.db
      .select()
      .from(orders)
      .where(
        and(eq(orders.id, orderId), or(isNull(orders.branchId), inArray(orders.branchId, branchIds))),
      )
      .limit(1);
    if (!order) throw new Error('Order not found for this company.');
    if (order.status === 'cancelled' || order.status === 'failed') {
      throw new Error('Cancelled or failed orders are not posted.');
    }

    const posted = await this.ledger.post({
      companyId,
      customerId: order.tradeCustomerId ?? null,
      orderId: order.id,
      documentType: 'invoice',
      documentNo: order.orderNumber,
      description: order.customerAccountType === 'credit' ? 'Credit invoice' : 'Cash invoice',
      direction: 'debit',
      amount: num(order.totalAmount),
      currency: order.currency,
      idempotencyKey: `invoice:${order.id}`,
    });
    return posted;
  }

  /** Manually post a credit for a payment that never hit the transaction ledger. */
  async postPaymentCredit(companyId: string, source: 'customer_ledger' | 'gateway_attempt', id: string): Promise<void> {
    if (source === 'customer_ledger') {
      return this.postPaymentCreditFromLedgerDocument(companyId, id);
    }
    return this.postPaymentCreditFromAttempt(companyId, id);
  }

  private async postPaymentCreditFromLedgerDocument(companyId: string, entryId: string): Promise<void> {
    const [entry] = await this.db
      .select()
      .from(customerLedgerEntries)
      .where(and(eq(customerLedgerEntries.id, entryId), eq(customerLedgerEntries.companyId, companyId)))
      .limit(1);
    if (!entry) throw new Error('Payment document not found for this company.');
    if (entry.documentType !== 'payment') throw new Error('Document is not a payment.');

    const amount = Math.abs(num(entry.amount));
    if (amount <= 0) throw new Error('Payment amount must be greater than 0.');

    const currency = await this.currencyFor(entry.orderId ?? null, null);
    const idempotencyKey = entry.orderId
      ? `payment:${entry.orderId}:${entry.documentNo}:${amount.toFixed(2)}`
      : `payment:${entry.customerId}:${entry.documentNo}:${amount.toFixed(2)}`;

    await this.ledger.post({
      companyId,
      customerId: entry.customerId,
      orderId: entry.orderId ?? null,
      documentType: 'payment',
      documentNo: entry.documentNo,
      description: 'Customer payment',
      direction: 'credit',
      amount,
      currency,
      transactionReference: entry.documentNo,
      idempotencyKey,
    });
  }

  private async postPaymentCreditFromAttempt(companyId: string, attemptId: string): Promise<void> {
    const [attempt] = await this.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, attemptId))
      .limit(1);
    if (!attempt) throw new Error('Payment attempt not found.');
    if (attempt.status !== 'successful') throw new Error('Only successful payments are posted.');

    const branchIds = await this.companyBranchIds(companyId);
    if (!branchIds.includes(attempt.branchId)) {
      throw new Error('Payment attempt not found for this company.');
    }

    const [order] = await this.db
      .select({
        tradeCustomerId: orders.tradeCustomerId,
        currency: orders.currency,
        transactionReference: orders.transactionReference,
        mpesaReceiptNumber: orders.mpesaReceiptNumber,
      })
      .from(orders)
      .where(eq(orders.id, attempt.orderId))
      .limit(1);

    const amount = num(attempt.amount);
    if (amount <= 0) throw new Error('Payment amount must be greater than 0.');

    const transactionReference =
      shownPaymentReference({
        paymentMethod: attempt.providerCode,
        transactionReference: order?.transactionReference,
        mpesaReceiptNumber: order?.mpesaReceiptNumber,
      }) || '';
    if (!transactionReference || transactionReference.startsWith('ws_CO_')) {
      throw new Error(
        'This payment has no provider transaction reference, so it cannot be posted to the ledger.',
      );
    }
    const currency = (attempt.currency || order?.currency || '').trim();
    if (!currency) throw new Error('A currency is required to post the transaction ledger.');

    await this.ledger.post({
      companyId,
      customerId: order?.tradeCustomerId ?? null,
      orderId: attempt.orderId,
      documentType: 'payment',
      documentNo: transactionReference,
      description: `Payment via ${attempt.providerCode}`,
      direction: 'credit',
      amount,
      currency,
      transactionReference,
      idempotencyKey: `payment:${attempt.orderId}:${transactionReference}:${amount.toFixed(2)}`,
    });
  }

  private async companyBranchIds(companyId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.companyId, companyId));
    return rows.map((row) => row.id);
  }

  private async currencyFor(orderId: string | null, fallback: string | null): Promise<string> {
    if (orderId) {
      const [order] = await this.db
        .select({ currency: orders.currency })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      if (order?.currency?.trim()) return order.currency.trim().toUpperCase();
    }
    if (fallback?.trim()) return fallback.trim().toUpperCase();
    throw new Error('A currency is required to post the transaction ledger.');
  }
}