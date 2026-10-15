import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { customers, orders, type PaymentMethodRow, type ProviderTransactionRow } from '@/server/db/drizzle/schema';
import type { C2bConsumer } from '@/server/domains/payments/daraja/c2b';
import { FinanceError, type FinanceContext } from '../errors';
import { fromCents } from '../domain/receivables';
import type { ReceiptService } from './receipt-service';

import { has } from '@/lib/values';

/**
 * Puts a payment that Safaricom confirmed (made straight to a paybill or till) on a customer's account:
 * a posted receipt through the payment method of that shortcode, so it lands in the right bank account,
 * G/L account and branch. Only when the account number given is a customer's own number; anything else
 * waits for a person to place it.
 */
export class FinanceC2bConsumer implements C2bConsumer {
  constructor(
    private readonly db: DrizzleDb,
    private readonly receipts: ReceiptService,
  ) {}

  async knownReference(companyId: string, reference: string | null): Promise<boolean> {
    const ref = reference?.trim();
    if (!has(ref)) return false;
    const [c] = await this.db.select({ id: customers.id }).from(customers).where(and(eq(customers.companyId, companyId), sql`lower(${customers.number}) = lower(${ref})`)).limit(1);
    if (c) return true;
    const [o] = await this.db.select({ id: orders.id }).from(orders).where(sql`lower(${orders.orderNumber}) = lower(${ref})`).limit(1);
    return Boolean(o);
  }

  /** A person chose the customer: the same receipt, made in their name. Problems are told, not hidden. */
  async place(tx: ProviderTransactionRow, method: PaymentMethodRow, customerId: string, actor: { id: string }) {
    const ctx: FinanceContext = { companyId: tx.companyId, actor: { type: 'user', id: actor.id }, origin: { surface: 'payments/activity', action: 'place_payment' } };
    const when = (tx.occurredAt ?? tx.createdAt).toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
    const created = await this.receipts.create(ctx, {
      customerId,
      paymentMethodId: method.id,
      amount: fromCents(Math.round(Number(tx.amount) * 100)),
      currency: tx.currency,
      paymentDate: when,
      postingDate: when,
      externalReference: tx.platformReference,
      payerName: tx.payerMasked,
      narration: `Paid to ${tx.shortcode ?? 'the business'} (${tx.platformReference})`,
      source: 'gateway',
      sourceRef: `provider_transaction:${tx.id}`,
      idempotencyKey: `provider_transaction:${tx.id}`,
    });
    await this.receipts.post(ctx, created.id, { allocate: 'oldest_first' });
    return { type: 'customer_receipt', id: created.id };
  }

  async allocate(tx: ProviderTransactionRow, info: { method: PaymentMethodRow; payerName: string | null; accountReference: string | null; autoAllocate: 'off' | 'by_customer_number' }) {
    if (info.autoAllocate !== 'by_customer_number') return null;
    const ref = info.accountReference?.trim();
    if (!has(ref)) return null;
    const [customer] = await this.db.select().from(customers).where(and(eq(customers.companyId, tx.companyId), sql`lower(${customers.number}) = lower(${ref})`)).limit(1);
    if (customer?.isActive !== true) return null;
    const ctx: FinanceContext = { companyId: tx.companyId, actor: { type: 'integration', id: tx.providerId }, origin: { surface: 'payments/c2b', action: 'auto_allocate' } };
    const when = (tx.occurredAt ?? tx.createdAt).toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
    try {
      const created = await this.receipts.create(ctx, {
        customerId: customer.id,
        paymentMethodId: info.method.id,
        amount: fromCents(Math.round(Number(tx.amount) * 100)),
        currency: tx.currency,
        paymentDate: when,
        postingDate: when,
        externalReference: tx.platformReference,
        payerName: info.payerName ?? tx.payerMasked,
        narration: `Paid to ${tx.shortcode ?? 'the business'} (${tx.platformReference})`,
        source: 'gateway',
        sourceRef: `provider_transaction:${tx.id}`,
        idempotencyKey: `provider_transaction:${tx.id}`,
      });
      await this.receipts.post(ctx, created.id, { allocate: 'oldest_first' });
      return { type: 'customer_receipt', id: created.id };
    } catch (error) {
      // A rule of the payment method (evidence needed, a closed period...) means a person has to place it.
      if (error instanceof FinanceError) return null;
      throw error;
    }
  }
}
