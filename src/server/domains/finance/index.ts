import type { DrizzleDb } from '@/server/db/drizzle/client';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import type { ReasonCodes } from '@/server/kernel/reason-codes/service';
import { PostingEngine } from './engine';
import { FiscalService } from './fiscal-service';
import { JournalService } from './journal-service';
import { FinanceMaintenanceService } from './maintenance-service';
import { PostingSetupService } from './posting-setup-service';
import { SalesPostingService } from './sales-posting-service';
import { FinanceReportsService } from './reports-service';
import { FinanceSetupService } from './setup-service';
import { BankAccountService } from './receivables/bank-account-service';
import { CustomerLedgerService } from './receivables/customer-ledger-service';
import { CreditNoteAccountingService } from './receivables/credit-note-accounting-service';
import { CreditPolicyService } from './receivables/credit-policy-service';
import { PaymentMethodService } from './receivables/payment-method-service';
import { WalletService } from './receivables/wallet-service';
import { ReceiptService } from './receivables/receipt-service';
import { RefundService } from './receivables/refund-service';
import { PaymentProviderService } from './payment-provider-service';
import type { PaymentConfigRepository } from '@/server/domains/payments/repository';
import type { PaymentService } from '@/server/domains/payments/service';
import { BankStatementService } from './receivables/bank-statement-service';
import { BankReconciliationService } from './receivables/bank-reconciliation-service';

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
  /** Takes invoices, cash sales, gateway payments and rebates to the general ledger. */
  salesPosting: SalesPostingService;
  /** The refund-or-wallet switch. */
  creditPolicy: CreditPolicyService;
  /** Customer credit held by the business (a liability). */
  wallets: WalletService;
  /** What a credit note does to the customer's account and the books, and its excess. */
  creditNoteAccounting: CreditNoteAccountingService;
  /** Money paid back out to customers. */
  refunds: RefundService;
  /** What the bank says happened, matched to our own records. */
  bankStatements: BankStatementService;
  /** Closing a bank account against its statement. */
  bankReconciliation: BankReconciliationService;
  /** Connections to payment services (company-wide); payment methods go through one each. */
  paymentProviders: PaymentProviderService;
}

export function createFinanceServices(
  db: DrizzleDb,
  decisions: DecisionLog,
  deps: { numbering: NumberSeriesService; reasons: ReasonCodes; paymentConfigs: PaymentConfigRepository; payments: PaymentService },
): FinanceServices {
  const fiscal = new FiscalService(db, decisions);
  const engine = new PostingEngine(db, decisions);
  const postingSetup = new PostingSetupService(db, decisions);
  const customerLedger = new CustomerLedgerService(db, decisions);
  const reports = new FinanceReportsService(db);
  const salesPosting = new SalesPostingService(db, decisions, engine, postingSetup);
  const creditPolicy = new CreditPolicyService(db, decisions);
  const wallets = new WalletService(db, decisions, engine, customerLedger, creditPolicy, salesPosting, postingSetup, deps.reasons);
  const receipts = new ReceiptService(db, decisions, engine, customerLedger, deps.numbering, deps.reasons, postingSetup, wallets, creditPolicy);
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
    salesPosting,
    creditPolicy,
    wallets,
    creditNoteAccounting: new CreditNoteAccountingService(db, decisions, engine, customerLedger, wallets, creditPolicy, postingSetup),
    refunds: new RefundService(db, decisions, engine, customerLedger, wallets, creditPolicy, postingSetup, deps.numbering, deps.reasons),
    maintenance: new FinanceMaintenanceService(db, decisions, reports, customerLedger, salesPosting),
    receipts,
    bankStatements: new BankStatementService(db, decisions, engine, receipts, deps.numbering, deps.reasons),
    bankReconciliation: new BankReconciliationService(db, decisions, deps.numbering, deps.reasons),
    paymentProviders: new PaymentProviderService(db, decisions, deps.paymentConfigs, deps.payments),
  };
}
