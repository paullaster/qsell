import { desc, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  customers,
  transactionLedgerEntries,
} from '@/server/db/drizzle/schema';

export const LEDGER_DOCUMENT_TYPES = ['invoice', 'payment'] as const;
export type LedgerDocumentType = (typeof LEDGER_DOCUMENT_TYPES)[number];
export type LedgerDirection = 'debit' | 'credit';

export type PostLedgerEntryInput = {
  companyId: string;
  documentType: LedgerDocumentType;
  documentNo: string;
  description?: string | null;
  direction: LedgerDirection;
  /** Positive amount. The direction says whether it is a debit or a credit. */
  amount: number;
  currency: string;
  customerId?: string | null;
  orderId?: string | null;
  /**
   * Provider payment reference (M-Pesa: MpesaReceiptNumber).
   * Required when documentType is payment.
   */
  transactionReference?: string | null;
  /** Same key posts once. A repeat is ignored. */
  idempotencyKey: string;
};

export type TransactionLedgerLine = {
  id: string;
  postedAt: Date;
  documentType: string;
  documentNo: string;
  description: string | null;
  direction: string;
  amount: string;
  currency: string;
  orderId: string | null;
  transactionReference: string | null;
  customerName: string | null;
  customerNumber: string | null;
};

type LedgerWriter = Pick<DrizzleDb, 'insert'>;

/**
 * The only writer of the transaction ledger.
 * Sales, payments, and any later document call `post`. They do not insert rows themselves.
 */
export class TransactionLedgerService {
  constructor(private readonly db: DrizzleDb) {}

  async post(input: PostLedgerEntryInput, writer: LedgerWriter = this.db): Promise<void> {
    const amount = Math.round(input.amount * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('A ledger entry amount must be greater than 0.');
    }
    if (input.direction !== 'debit' && input.direction !== 'credit') {
      throw new Error('A ledger entry must be a debit or a credit.');
    }
    if (!LEDGER_DOCUMENT_TYPES.includes(input.documentType)) {
      throw new Error('This document cannot be posted to the transaction ledger.');
    }

    const currency = input.currency.trim().toUpperCase();
    if (!currency) throw new Error('A currency is required to post the transaction ledger.');

    const documentNo = input.documentNo.trim();
    if (!documentNo) throw new Error('A ledger entry needs a document number.');

    const transactionReference = input.transactionReference?.trim() || null;
    if (input.documentType === 'payment' && !transactionReference) {
      throw new Error('A payment ledger entry requires the provider transaction reference.');
    }

    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw new Error('A ledger entry needs an idempotency key.');

    await writer
      .insert(transactionLedgerEntries)
      .values({
        companyId: input.companyId,
        customerId: input.customerId ?? null,
        orderId: input.orderId ?? null,
        documentType: input.documentType,
        documentNo,
        description: input.description?.trim() || null,
        direction: input.direction,
        amount: amount.toFixed(2),
        currency,
        transactionReference: input.documentType === 'payment' ? transactionReference : null,
        idempotencyKey,
      })
      .onConflictDoNothing({ target: transactionLedgerEntries.idempotencyKey });
  }

  async list(companyId: string): Promise<TransactionLedgerLine[]> {
    return this.db
      .select({
        id: transactionLedgerEntries.id,
        postedAt: transactionLedgerEntries.postedAt,
        documentType: transactionLedgerEntries.documentType,
        documentNo: transactionLedgerEntries.documentNo,
        description: transactionLedgerEntries.description,
        direction: transactionLedgerEntries.direction,
        amount: transactionLedgerEntries.amount,
        currency: transactionLedgerEntries.currency,
        orderId: transactionLedgerEntries.orderId,
        transactionReference: transactionLedgerEntries.transactionReference,
        customerName: customers.name,
        customerNumber: customers.number,
      })
      .from(transactionLedgerEntries)
      .leftJoin(customers, eq(customers.id, transactionLedgerEntries.customerId))
      .where(eq(transactionLedgerEntries.companyId, companyId))
      .orderBy(desc(transactionLedgerEntries.postedAt));
  }
}
