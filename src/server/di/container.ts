import type { EmailPort, InvoicePdfPort } from '@/server/ports/communications';
import { PdfKitInvoiceAdapter } from '@/server/adapters/pdf/pdfkit-invoice.adapter';
import {
  ConsoleEmailAdapter,
  NodemailerSmtpAdapter,
} from '@/server/adapters/email/nodemailer.adapter';
import { drizzleDb, type DrizzleDb } from '@/server/db/drizzle/client';
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
import { AccessControlService } from '@/server/domains/access-control/engine';
import { UsersAdminRepository } from '@/server/domains/users/repository';
import { seedAccessControl } from '@/server/domains/access-control/seed';
import { CatalogRepository, PaymentRecordsRepository } from '@/server/domains/catalog/repository';
import { UserSessionRepository } from '@/server/domains/auth/session-repository';
import { AuthTokenRepository } from '@/server/domains/auth/token-repository';
import { AccountService } from '@/server/domains/auth/account-service';

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
  usersAdmin: UsersAdminRepository;
  accessControl: AccessControlService;
  dimensions: DimensionRepository;
  dimensionSets: DimensionSetService;
  customers: CustomerMasterService;
  transactionLedger: TransactionLedgerService;
  transactionReconcile: TransactionReconcileService;
  paymentCallbacks: PaymentCallbackService;
  catalog: CatalogRepository;
  paymentRecords: PaymentRecordsRepository;
  userSessions: UserSessionRepository;
  authTokens: AuthTokenRepository;
  accounts: AccountService;
}

function createEmailPort(): EmailPort {
  const driver = (process.env.EMAIL_DRIVER ?? 'console').toLowerCase();
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
  void users.ensureSuperAdminSeed().catch((err: unknown) => {
    console.error('[auth] super admin seed failed', err);
  });
  const usersAdmin = new UsersAdminRepository(drizzleDb);
  const accessControl = new AccessControlService(drizzleDb);
  // Bootstrap the permission catalog + system roles from code.
  void seedAccessControl(accessControl.repo).catch((err: unknown) => {
    console.error('[access-control] seed failed', err);
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
  const catalog = new CatalogRepository(drizzleDb);
  const paymentRecords = new PaymentRecordsRepository(drizzleDb);
  const userSessions = new UserSessionRepository(drizzleDb);
  const authTokens = new AuthTokenRepository(drizzleDb);
  const accounts = new AccountService({
    db: drizzleDb,
    users,
    tokens: authTokens,
    email,
    companySettings,
  });

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
    usersAdmin,
    accessControl,
    dimensions,
    dimensionSets,
    customers,
    transactionLedger,
    transactionReconcile,
    paymentCallbacks,
    catalog,
    paymentRecords,
    userSessions,
    authTokens,
    accounts,
  };

  return container;
}

/** Test helper — reset composition root between suites. */
export function resetContainer(): void {
  container = null;
}
