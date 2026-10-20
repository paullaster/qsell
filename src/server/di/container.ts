import { ParkedActions } from '@/server/kernel/approvals/parked-actions';
import { registerApprovalHandlers } from '@/server/di/approval-wiring';
import { ApprovalConfigService } from '@/server/kernel/approvals/config-service';
import { ApprovalEngine } from '@/server/kernel/approvals/engine';
import { PricingConfigService } from '@/server/domains/pricing/config-service';
import { PricingService } from '@/server/domains/pricing/service';
import { PriceGuardService } from '@/server/domains/pricing/guard-service';
import { RebateService } from '@/server/domains/pricing/rebate-service';
import { RebateConfigService } from '@/server/domains/pricing/rebate-config-service';
import { LoyaltyService } from '@/server/domains/pricing/loyalty-service';
import { GiftCardService } from '@/server/domains/pricing/giftcard-service';
import { OrderTenderService } from '@/server/domains/pricing/tender-service';
import { ReturnReceiptService } from '@/server/domains/returns/return-receipt-service';
import { InsightsService } from '@/server/domains/pricing/insights-service';
import { PriceBookService } from '@/server/domains/pricing/price-book-service';
import { DiscountService } from '@/server/domains/pricing/discount-service';
import { DiscountConfigService } from '@/server/domains/pricing/discount-config-service';
import { KitConfigService, KitService } from '@/server/domains/pricing/kit-service';
import { PriceGuardConfigService } from '@/server/domains/pricing/guard-config-service';
import type { EmailPort, InvoicePdfPort } from '@/server/ports/communications';
import { PdfKitInvoiceAdapter } from '@/server/adapters/pdf/pdfkit-invoice.adapter';
import {
  ConsoleEmailAdapter,
  NodemailerSmtpAdapter,
} from '@/server/adapters/email/nodemailer.adapter';
import { eq, sql } from 'drizzle-orm';
import { companySettings, customers, salesQuoteSettings } from '@/server/db/drizzle/schema';
import { ReportsService } from '@/server/domains/reports/service';
import { drizzleDb, kernelDb, type DrizzleDb } from '@/server/db/drizzle/client';
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
import { UnitRepository } from '@/server/domains/units/repository';
import { UnitWriteService } from '@/server/domains/units/write-service';
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
import { ProductImportService } from '@/server/domains/catalog/import-service';
import { MediaService } from '@/server/domains/media/service';
import { MediaPortRegistry } from '@/server/adapters/media/registry';
import { KraConfigRepository } from '@/server/domains/kra/repository';
import { KraConfigResolver } from '@/server/domains/kra/resolver';
import { EtimsTransmissionService } from '@/server/domains/kra/etims/transmission-service';
import { EtimsItemService } from '@/server/domains/kra/etims/item-service';
import { KraSigningPolicy } from '@/server/domains/kra/signing/policy';
import { DecisionLog } from '@/server/kernel/decision-log/service';
import { ReasonCodes } from '@/server/kernel/reason-codes/service';
import { NumberSeriesService } from '@/server/kernel/numbering/service';
import { createFinanceServices, type FinanceServices } from '@/server/domains/finance';
import { ProjectService } from '@/server/domains/projects/service';
import { createPaymentEngine, type PaymentEngine } from '@/server/domains/payments/engine';
import { FinanceC2bConsumer } from '@/server/domains/finance/receivables/c2b-consumer';
import { CreditNoteService } from '@/server/domains/credit-notes/service';
import { DocumentSigningService } from '@/server/domains/kra/signing/service';
import { getWorkerUtils } from '@/server/queue/worker';

/** Installs/updates the job-queue schema once per process, before the first enqueue. */
let queueReady: Promise<void> | null = null;
function ensureQueueSchema(): Promise<void> {
  queueReady ??= getWorkerUtils()
    .then(async (utils) => {
      await utils.migrate();
    })
    .catch((error: unknown) => {
      queueReady = null;
      throw error;
    });
  return queueReady;
}

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
  reports: ReportsService;
  dimensions: DimensionRepository;
  units: UnitRepository;
  unitWriter: UnitWriteService;
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
  productImports: ProductImportService;
  media: MediaService;
  kraConfigs: KraConfigRepository;
  kraResolver: KraConfigResolver;
  etimsTransmission: EtimsTransmissionService;
  etimsItems: EtimsItemService;
  kraSigning: DocumentSigningService;
  creditNotes: CreditNoteService;
  decisionLog: DecisionLog;
  reasonCodes: ReasonCodes;
  numbering: NumberSeriesService;
  /** Chart of accounts, fiscal periods, posting setup, the posting engine, journals, ledger reports. */
  finance: FinanceServices;
  /** Work for a customer or for the company, with tasks and a budget. */
  projects: ProjectService;
  /** The doors payment platforms knock on, and the checks that decide whether a payment is real. */
  paymentEngine: PaymentEngine;
  approvals: ApprovalEngine;
  approvalConfig: ApprovalConfigService;
  /** Parks actions that need approval and carries them out when approved. */
  approvalGate: ParkedActions;
  /** Prices lines from price lists, with the reasons. Read only. */
  pricing: PricingService;
  pricingConfig: PricingConfigService;
  priceGuard: PriceGuardService;
  priceGuardConfig: PriceGuardConfigService;
  discounts: DiscountService;
  discountConfig: DiscountConfigService;
  kits: KitService;
  kitConfig: KitConfigService;
  rebates: RebateService;
  rebateConfig: RebateConfigService;
  loyalty: LoyaltyService;
  giftCards: GiftCardService;
  tenders: OrderTenderService;
  returns: ReturnReceiptService;
  insights: InsightsService;
  priceBook: PriceBookService;
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

/**
 * Where the old numbering schemes left off, so the standard series carry on from there rather
 * than restarting at 1 (quotes had a counter; customers were numbered by counting them).
 */
async function legacyCounterStart(companyId: string, kind: string): Promise<number | null> {
  if (kind === 'sales_quote') {
    const [row] = await kernelDb
      .select({ next: salesQuoteSettings.nextQuoteNumber })
      .from(salesQuoteSettings)
      .where(eq(salesQuoteSettings.companyId, companyId))
      .limit(1);
    return row?.next ?? null;
  }
  if (kind === 'customer') {
    const [row] = await kernelDb
      .select({ count: sql<number>`count(*)::int` })
      .from(customers)
      .where(eq(customers.companyId, companyId));
    return (row?.count ?? 0) + 1;
  }
  return null;
}

/**
 * The company's configured invoice prefix shapes the first tax invoice series, so existing
 * setups keep their look ("INV" becomes "INV-{BRANCH}-{YY}-"). Anything else uses the standard.
 */
async function legacyPrefix(companyId: string, kind: string): Promise<string | null> {
  if (kind !== 'tax_invoice') return null;
  const [row] = await kernelDb
    .select({ prefix: companySettings.invoicePrefix })
    .from(companySettings)
    .where(eq(companySettings.id, companyId))
    .limit(1);
  const base = row.prefix
    .trim()
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 6);
  return base !== '' ? `${base}-{BRANCH}-{YY}-` : null;
}

/**
 * Number series run on two connection pools: the document's own transaction uses the main one,
 * while block reservation and first-use setup (which happen while that transaction is open) use
 * a small pool of their own, so numbering can never starve the transactions waiting on it.
 */
function createNumbering(decisionLog: DecisionLog, reasonCodes: ReasonCodes): NumberSeriesService {
  const setup = new NumberSeriesService(
    kernelDb,
    new DecisionLog(kernelDb),
    new ReasonCodes(kernelDb),
    { legacyStart: legacyCounterStart, legacyPrefix, counterDb: kernelDb, autoSetup: false },
  );
  return new NumberSeriesService(drizzleDb, decisionLog, reasonCodes, {
    legacyStart: legacyCounterStart,
    legacyPrefix,
    counterDb: kernelDb,
    setupService: setup,
    // A sale must not fail because a document has no branch: fiscal series that number per
    // branch use the company's default branch then.
    fallbackToDefaultBranch: true,
  });
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
  const units = new UnitRepository(drizzleDb);
  const unitWriter = new UnitWriteService(units);
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

  const media = new MediaService(drizzleDb, new MediaPortRegistry());
  const kraConfigs = new KraConfigRepository(drizzleDb);
  const kraResolver = new KraConfigResolver(branches, kraConfigs);
  const etimsTransmission = new EtimsTransmissionService(drizzleDb, kraResolver);
  const etimsItems = new EtimsItemService(drizzleDb, kraResolver, branches);
  const kraSigning = new DocumentSigningService(
    drizzleDb,
    new KraSigningPolicy(branches, kraConfigs, kraResolver),
    etimsItems,
    etimsTransmission,
  );
  const decisionLog = new DecisionLog(drizzleDb);
  const reasonCodes = new ReasonCodes(drizzleDb);
  const numbering = createNumbering(decisionLog, reasonCodes);
  const creditNotes = new CreditNoteService(drizzleDb, kraSigning, numbering);
  const finance = createFinanceServices(drizzleDb, decisionLog, { numbering, reasons: reasonCodes, paymentConfigs, payments });
  const paymentEngine = createPaymentEngine({ db: drizzleDb, registry: paymentRegistry, payments, consumer: new FinanceC2bConsumer(drizzleDb, finance.receipts) });
  paymentEngine.payoutConsumer = { finished: async (op) => { if (op.subjectType === 'refund') await finance.refunds.onAutomaticPayoutFinished(op); } };

  const approvals = new ApprovalEngine(drizzleDb, decisionLog, reasonCodes);
  const approvalGate = new ParkedActions(drizzleDb, approvals);
  const pricing = new PricingService(drizzleDb);
  const priceGuard = new PriceGuardService(drizzleDb, accessControl);
  const discounts = new DiscountService(drizzleDb, pricing, priceGuard);
  const kits = new KitService(drizzleDb);
  const rebates = new RebateService(drizzleDb, priceGuard, pricing);
  const loyalty = new LoyaltyService(drizzleDb, decisionLog, reasonCodes, finance.fx);
  const giftCards = new GiftCardService(drizzleDb, decisionLog, reasonCodes, finance.fx);
  const insights = new InsightsService(drizzleDb, priceGuard);
  const pricingConfig = new PricingConfigService(
    drizzleDb,
    decisionLog,
    reasonCodes,
    pricing,
    approvals,
    approvalGate,
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
    usersAdmin,
    accessControl,
    reports: new ReportsService(drizzleDb, accessControl),
    dimensions,
    units,
    unitWriter,
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
    productImports: new ProductImportService(drizzleDb, ensureQueueSchema, media, {
      numbering: () => numbering,
      companyId: async () => (await companySettings.ensureSeeded()).id,
    }),
    media,
    kraConfigs,
    kraResolver,
    etimsTransmission,
    etimsItems,
    kraSigning,
    creditNotes,
    decisionLog,
    reasonCodes,
    numbering,
    finance,
    projects: new ProjectService(drizzleDb, decisionLog, numbering),
    paymentEngine,
    approvals,
    approvalConfig: new ApprovalConfigService(drizzleDb, decisionLog, reasonCodes),
    approvalGate,
    pricing,
    priceGuard,
    priceGuardConfig: new PriceGuardConfigService(drizzleDb, decisionLog, reasonCodes, priceGuard),
    pricingConfig,
    discounts,
    kits,
    kitConfig: new KitConfigService(drizzleDb, decisionLog, reasonCodes, kits),
    rebates,
    rebateConfig: new RebateConfigService(drizzleDb, decisionLog, reasonCodes, rebates, approvals),
    loyalty,
    giftCards,
    returns: new ReturnReceiptService(drizzleDb, decisionLog, numbering, reasonCodes),
    tenders: new OrderTenderService(drizzleDb, decisionLog, giftCards, loyalty, rebates, () => finance.wallets),
    discountConfig: new DiscountConfigService(
      drizzleDb,
      decisionLog,
      reasonCodes,
      discounts,
      pricing,
      pricingConfig,
      approvals,
      insights,
    ),
    insights,
    priceBook: new PriceBookService(drizzleDb, pricing, priceGuard, discounts),
  };
  registerApprovalHandlers(approvals, approvalGate);

  return container;
}

/** Test helper — reset composition root between suites. */
export function resetContainer(): void {
  container = null;
}
