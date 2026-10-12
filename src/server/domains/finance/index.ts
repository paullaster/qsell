import type { DrizzleDb } from '@/server/db/drizzle/client';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import type { ReasonCodes } from '@/server/kernel/reason-codes/service';
import { PostingEngine } from './engine';
import { FiscalService } from './fiscal-service';
import { JournalService } from './journal-service';
import { FinanceMaintenanceService } from './maintenance-service';
import { PostingSetupService } from './posting-setup-service';
import { FinanceReportsService } from './reports-service';
import { FinanceSetupService } from './setup-service';
import { BankAccountService } from './receivables/bank-account-service';
import { CustomerLedgerService } from './receivables/customer-ledger-service';
import { PaymentMethodService } from './receivables/payment-method-service';
import { ReceiptService } from './receivables/receipt-service';

export interface FinanceServices {
  setup: FinanceSetupService;
  fiscal: FiscalService;
  postingSetup: PostingSetupService;
  /** The one door for money: nothing else writes the ledgers. */
  engine: PostingEngine;
  journals: JournalService;
  reports: FinanceReportsService;
  /** The customer sub-ledger: detailed entries, apply / unapply, statements, ageing. */
  customerLedger: CustomerLedgerService;
  bankAccounts: BankAccountService;
  paymentMethods: PaymentMethodService;
  receipts: ReceiptService;
  /** Scheduled jobs: ledger partitions and the nightly integrity check. */
  maintenance: FinanceMaintenanceService;
}

export function createFinanceServices(
  db: DrizzleDb,
  decisions: DecisionLog,
  deps: { numbering: NumberSeriesService; reasons: ReasonCodes },
): FinanceServices {
  const fiscal = new FiscalService(db, decisions);
  const engine = new PostingEngine(db, decisions);
  const postingSetup = new PostingSetupService(db, decisions);
  const customerLedger = new CustomerLedgerService(db, decisions);
  const reports = new FinanceReportsService(db);
  return {
    fiscal,
    engine,
    setup: new FinanceSetupService(db, decisions, fiscal),
    postingSetup,
    journals: new JournalService(db, engine, decisions),
    reports,
    customerLedger,
    bankAccounts: new BankAccountService(db, decisions),
    paymentMethods: new PaymentMethodService(db, decisions),
    maintenance: new FinanceMaintenanceService(db, decisions, reports, customerLedger),
    receipts: new ReceiptService(db, decisions, engine, customerLedger, deps.numbering, deps.reasons, postingSetup),
  };
}
