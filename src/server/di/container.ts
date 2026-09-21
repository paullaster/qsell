import type { EmailPort, InvoicePdfPort } from '@/server/ports/communications';
import { PdfKitInvoiceAdapter } from '@/server/adapters/pdf/pdfkit-invoice.adapter';
import {
  ConsoleEmailAdapter,
  NodemailerSmtpAdapter,
} from '@/server/adapters/email/nodemailer.adapter';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { drizzleDb } from '@/server/db/drizzle/client';
import { CompanySettingsRepository } from '@/server/domains/company/repository';
import { InvoiceService } from '@/server/domains/invoices/service';
import { BranchRepository, OrganizationRepository } from '@/server/domains/branches/repository';
import { PaymentRegistry } from '@/server/domains/payments/registry';
import { PaymentService } from '@/server/domains/payments/service';
import {
  PaymentConfigRepository,
  PaymentAttemptRepository,
} from '@/server/domains/payments/repository';
import { OrderRepository } from '@/server/domains/orders/repository';
import { UserRepository } from '@/server/domains/auth/user-repository';
import { DimensionRepository } from '@/server/domains/dimensions/repository';
import { DimensionSetService } from '@/server/domains/dimensions/set-service';
import { CustomerMasterService } from '@/server/domains/customers/master-service';
import { TransactionLedgerService } from '@/server/domains/transactions/ledger-service';
import { TransactionReconcileService } from '@/server/domains/transactions/reconcile-service';
import { PaymentCallbackService } from '@/server/domains/payments/callback-service';

export interface AppContainer {
  db: DrizzleDb;
  invoicePdf: InvoicePdfPort;
  email: EmailPort;
  companySettings: CompanySettingsRepository;
  invoices: InvoiceService;
  branches: BranchRepository;
  organizations: OrganizationRepository;
  paymentRegistry: PaymentRegistry;
  paymentConfigs: PaymentConfigRepository;
  paymentAttempts: PaymentAttemptRepository;
  payments: PaymentService;
  orders: OrderRepository;
  users: UserRepository;
  dimensions: DimensionRepository;
  dimensionSets: DimensionSetService;
  customers: CustomerMasterService;
  transactionLedger: TransactionLedgerService;
  transactionReconcile: TransactionReconcileService;
  paymentCallbacks: PaymentCallbackService;
}

function createEmailPort(): EmailPort {
  const driver = (process.env.EMAIL_DRIVER || 'console').toLowerCase();
  if (driver === 'smtp') {
    return new NodemailerSmtpAdapter();
  }
  return new ConsoleEmailAdapter();
}

function createPdfPort(): InvoicePdfPort {
  return new PdfKitInvoiceAdapter();
}

let container: AppContainer | null = null;

export function getContainer(): AppContainer {
  if (container) return container;

  const invoicePdf = createPdfPort();
  const email = createEmailPort();
  const companySettings = new CompanySettingsRepository(drizzleDb);
  const invoices = new InvoiceService({
    db: drizzleDb,
    companySettings,
    invoicePdf,
    email,
  });
  const branches = new BranchRepository(drizzleDb);
  const organizations = new OrganizationRepository(drizzleDb);
  const paymentRegistry = new PaymentRegistry();
  const paymentConfigs = new PaymentConfigRepository(drizzleDb);
  const paymentAttempts = new PaymentAttemptRepository(drizzleDb);
  const payments = new PaymentService(drizzleDb, paymentRegistry, paymentConfigs, paymentAttempts);
  const orders = new OrderRepository(drizzleDb);
  const users = new UserRepository(drizzleDb);
  // Ensure deployment super-admin exists on first container boot.
  void users.ensureSuperAdminSeed().catch((err) => {
    console.error('[auth] super admin seed failed', err);
  });
  const dimensions = new DimensionRepository(drizzleDb);
  const dimensionSets = new DimensionSetService(drizzleDb, dimensions);
  const transactionLedger = new TransactionLedgerService(drizzleDb);
  const transactionReconcile = new TransactionReconcileService(drizzleDb, transactionLedger);
  const customers = new CustomerMasterService(drizzleDb, dimensionSets, transactionLedger);
  const paymentCallbacks = new PaymentCallbackService(
    drizzleDb,
    paymentRegistry,
    paymentConfigs,
    paymentAttempts,
  );

  container = {
    db: drizzleDb,
    invoicePdf,
    email,
    companySettings,
    invoices,
    branches,
    organizations,
    paymentRegistry,
    paymentConfigs,
    paymentAttempts,
    payments,
    orders,
    users,
    dimensions,
    dimensionSets,
    customers,
    transactionLedger,
    transactionReconcile,
    paymentCallbacks,
  };

  return container;
}

/** Test helper — reset composition root between suites. */
export function resetContainer(): void {
  container = null;
}
