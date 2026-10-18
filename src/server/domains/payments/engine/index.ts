import type { DrizzleDb } from '@/server/db/drizzle/client';
import { DarajaC2b, type C2bConsumer } from '../daraja/c2b';
import { DarajaOperations } from '../daraja/operations';
import { DarajaDisbursements } from '../daraja/disbursements';
import type { PaymentRegistry } from '../registry';
import type { PaymentService } from '../service';
import { PlatformContexts } from './context';
import { ProviderEventService } from './event-service';
import { GraphileJobs, type PaymentJobs } from './jobs';
import { ProviderOperationService } from './operation-service';
import { PaymentEngine } from './payment-engine';
import { PaymentActivityService } from './activity-service';
import { ProviderTransactionStore } from './transaction-store';
import { PaymentVerificationService } from './verification-service';
import { BillInvoiceService } from './bill-invoice-service';

export interface PaymentEngineDeps {
  db: DrizzleDb;
  registry: PaymentRegistry;
  payments: PaymentService;
  consumer: C2bConsumer | null;
  jobs?: PaymentJobs;
  fetchImpl?: typeof fetch;
}

/** Builds the payment engine and attaches it to the payment service (which settles what the engine verifies). */
export function createPaymentEngine(deps: PaymentEngineDeps): PaymentEngine {
  const { db } = deps;
  const jobs = deps.jobs ?? new GraphileJobs();
  const contexts = new PlatformContexts(db, deps.fetchImpl);
  const events = new ProviderEventService(db);
  const ops = new ProviderOperationService(db);
  const txs = new ProviderTransactionStore(db);
  const daraja = new DarajaOperations(db, ops, contexts, jobs);
  const verification = new PaymentVerificationService(db, contexts, deps.registry, events, ops, txs, jobs, deps.payments, {
    // A strict check of an STK payment asks for Safaricom's record of the transaction by its receipt.
    checkTransaction: async ({ providerId, attemptId, receipt }) => {
      const ctx = await contexts.forProvider(providerId);
      await daraja.start({
        providerId,
        operation: 'transaction_status',
        input: { transactionId: receipt, shortcode: (ctx.credentials as { shortcode?: string }).shortcode },
        idempotencyKey: `txs:${receipt}`,
        subject: { type: 'payment_attempt', id: attemptId },
      });
    },
  });
  const c2b = new DarajaC2b(db, contexts, events, ops, txs, daraja, jobs, deps.consumer);
  const disbursements = new DarajaDisbursements(db, ops, contexts, jobs);
  const engine = new PaymentEngine(db, contexts, deps.registry, events, ops, txs, jobs, verification, daraja, c2b, disbursements, deps.payments, deps.consumer);
  engine.activity = new PaymentActivityService(db);
  const bills = new BillInvoiceService(db);
  bills.daraja = daraja;
  c2b.onPlaced = async (tx) => {
    await bills.paymentPlaced(tx);
  };
  engine.bills = bills;
  deps.payments.useEngine(engine);
  return engine;
}

export type { PaymentEngine };
