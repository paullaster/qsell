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
import { VendorService } from '@/server/domains/vendors/service';
import { VendorFileStore } from '@/server/domains/vendors/file-store';
import { VendorProfileService } from '@/server/domains/vendors/profile-service';
import { VendorReviewService } from '@/server/domains/vendors/review-service';
import { VendorNotifier } from '@/server/domains/vendors/notifier';
import { OrderSlaService } from '@/server/domains/orders/sla-service';
import { StockLocationService } from '@/server/domains/stock/locations';
import { StockLedger } from '@/server/domains/stock/ledger';
import { StockAvailability } from '@/server/domains/stock/availability';
import { StockShadow } from '@/server/domains/stock/shadow';
import { StockSettingsService } from '@/server/domains/stock/settings';
import { TransferService } from '@/server/domains/stock/transfers';
import { CountService } from '@/server/domains/stock/counts';
import { StockReservations } from '@/server/domains/stock/reservations';
import { OrderSlaNotifier } from '@/server/domains/orders/sla-notifier';
import { VendorBankChangeService } from '@/server/domains/vendors/bank-change-service';
import { VendorLifecycleService } from '@/server/domains/vendors/lifecycle-service';
import { VendorExpiryService } from '@/server/domains/vendors/expiry-service';
import { VendorInvitationService } from '@/server/domains/vendors/invitation-service';
import { VendorDocumentTypeService } from '@/server/domains/vendors/document-type-service';
import { CategoryService } from '@/server/domains/vendors/category-service';
import { PrequalService } from '@/server/domains/vendors/prequal-service';
import { PrequalReviewService } from '@/server/domains/vendors/prequal-review-service';
import { PrequalLifecycle } from '@/server/domains/vendors/prequal-lifecycle';
import { RfqService } from '@/server/domains/vendors/rfq-service';
import { RfqPortalService } from '@/server/domains/vendors/rfq-portal-service';
import { RfqEvaluationService } from '@/server/domains/vendors/rfq-evaluation-service';
import { PurchaseOrderService } from '@/server/domains/vendors/po-service';
import { PurchaseOrderPortalService } from '@/server/domains/vendors/po-portal-service';
import { AdvancePaymentService } from '@/server/domains/vendors/advance-service';
import { RgnService } from '@/server/domains/vendors/rgn-service';
import { SupplierInvoicePortalService } from '@/server/domains/vendors/invoice-portal-service';
import { SupplierInvoiceService } from '@/server/domains/vendors/invoice-service';
import { SupplierInvoicePostingService } from '@/server/domains/vendors/invoice-posting-service';
import { VendorPaymentService } from '@/server/domains/vendors/payment-service';
import { PayablesReportService } from '@/server/domains/vendors/payables-report-service';
import { PaymentRunService } from '@/server/domains/vendors/payment-run-service';
import { PaymentTermsService } from '@/server/domains/vendors/payment-terms-service';
import { CreditMemoPortalService } from '@/server/domains/vendors/credit-memo-portal-service';
import { CreditMemoService } from '@/server/domains/vendors/credit-memo-service';
import { PayablesFxService } from '@/server/domains/vendors/payables-fx-service';
import { EdiService } from '@/server/domains/vendors/edi-service';
import { ScorecardService } from '@/server/domains/vendors/scorecard-service';
import { LandedCostService } from '@/server/domains/vendors/landed-cost-service';
import { ContractService } from '@/server/domains/vendors/contract-service';
import { RequisitionService } from '@/server/domains/vendors/requisition-service';
import { PurchaseReturnService } from '@/server/domains/vendors/purchase-return-service';
import { VendorRefundService } from '@/server/domains/vendors/refund-service';
import { RateLimitService } from '@/server/kernel/rate-limit/service';
import { VendorInsightsService } from '@/server/domains/vendors/insights-service';
import { PettyCashService } from '@/server/domains/vendors/petty-cash-service';
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
  orderSla: OrderSlaService;
  stockLocations: StockLocationService;
  stockLedger: StockLedger;
  stockAvailability: StockAvailability;
  stockShadow: StockShadow;
  stockSettings: StockSettingsService;
  stockReservations: StockReservations;
  stockTransfers: TransferService;
  stockCounts: CountService;
  users: UserRepository;
  usersAdmin: UsersAdminRepository;
  accessControl: AccessControlService;
  reports: ReportsService;
  dimensions: DimensionRepository;
  units: UnitRepository;
  unitWriter: UnitWriteService;
  dimensionSets: DimensionSetService;
  customers: CustomerMasterService;
  /** Vendors: the master record, portal links and events (F-7). */
  vendors: VendorService;
  /** A vendor's own profile, documents and submission (portal side). */
  vendorProfile: VendorProfileService;
  /** Staff review of a submitted profile: verify documents, approve, send back, refuse. */
  vendorReview: VendorReviewService;
  vendorFiles: VendorFileStore;
  vendorNotifier: VendorNotifier;
  /** Changes to an approved vendor's bank details, under change control. */
  vendorBank: VendorBankChangeService;
  vendorLifecycle: VendorLifecycleService;
  vendorExpiry: VendorExpiryService;
  vendorInvitations: VendorInvitationService;
  vendorDocumentTypes: VendorDocumentTypeService;
  /** Procurement categories, vendor prequalification, and the question "is this vendor qualified for that category". */
  categories: CategoryService;
  prequal: PrequalService;
  prequalReview: PrequalReviewService;
  prequalLifecycle: PrequalLifecycle;
  /** Requests for quotation: the document, the vendor's side, and the buyer's comparison and award. */
  rfqs: RfqService;
  rfqPortal: RfqPortalService;
  rfqEvaluation: RfqEvaluationService;
  /** Purchase orders, the vendor's view of them, and the advance payment document. */
  purchaseOrders: PurchaseOrderService;
  poPortal: PurchaseOrderPortalService;
  advances: AdvancePaymentService;
  /** Received goods notes: what arrived against an order, stock in, reversal, and received-not-invoiced. */
  rgns: RgnService;
  /** Supplier invoices: the vendor's own side, the staff pipeline, and booking to payables. */
  invoicePortal: SupplierInvoicePortalService;
  supplierInvoices: SupplierInvoiceService;
  invoicePosting: SupplierInvoicePostingService;
  /** Payment vouchers for invoices and advances, and what we owe (ageing, statements). */
  vendorPayments: VendorPaymentService;
  payablesReports: PayablesReportService;
  /** Payment runs: suggested from what is due, approved as one, released as a bank file or a cheque run. */
  paymentRuns: PaymentRunService;
  /** The rules of paying vendors: withholding codes, discount terms, payment accounts, tolerance, and certificates. */
  paymentTerms: PaymentTermsService;
  /** Credit notes from vendors: the vendor's side, and the staff pipeline that books them. */
  creditMemoPortal: CreditMemoPortalService;
  creditMemos: CreditMemoService;
  /** Petty cash: floats with a custodian and limits, small vouchers with receipts, and top-ups. */
  pettyCash: PettyCashService;
  /** Cross-vendor reports: commitments, performance, purchases and the watch list. */
  vendorInsights: VendorInsightsService;
  /** Request limits for sign-in, registration, mail forms and vendor uploads and submits. */
  rateLimits: RateLimitService;
  /** Money vendors pay back to us. */
  vendorRefunds: VendorRefundService;
  /** Goods sent back to vendors after they were received. */
  purchaseReturns: PurchaseReturnService;
  /** Internal requests to buy, approved and turned into quotation requests or orders. */
  requisitions: RequisitionService;
  /** Contracts (blanket orders): agreed prices for a period, with limits, that orders are called off against. */
  contracts: ContractService;
  /** Freight, duty and similar charges added to what received goods cost. */
  landedCosts: LandedCostService;
  /** The vendor scorecard: weighted measures and people's ratings. */
  scorecards: ScorecardService;
  /** UBL documents: orders out, invoices in. */
  edi: EdiService;
  /** Foreign-currency payables: revaluation at today's rate, undone the next day. */
  payablesFx: PayablesFxService;
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
  const vendors = new VendorService(drizzleDb, numbering);
  const vendorFiles = new VendorFileStore(drizzleDb);
  const stockLocations = new StockLocationService(drizzleDb);
  const stockLedger = new StockLedger(drizzleDb);
  const orderSla = new OrderSlaService(drizzleDb, new OrderSlaNotifier(email, companySettings));
  const vendorNotifier = new VendorNotifier(drizzleDb, email, companySettings);
  const prequalLifecycle = new PrequalLifecycle(drizzleDb, vendorNotifier);
  const rfqService = new RfqService(drizzleDb, numbering, prequalLifecycle, vendorNotifier);
  const advancePayments = new AdvancePaymentService(drizzleDb, vendorNotifier);
  const vendorProfileService = new VendorProfileService(drizzleDb, vendorFiles, vendorNotifier);
  const purchaseOrderService = new PurchaseOrderService(drizzleDb, numbering, prequalLifecycle, vendorNotifier);
  const finance = createFinanceServices(drizzleDb, decisionLog, { numbering, reasons: reasonCodes, paymentConfigs, payments });
  const rgnService = new RgnService(drizzleDb, numbering, finance.fx);
  const invoicePortal = new SupplierInvoicePortalService(drizzleDb, numbering, vendorFiles, advancePayments, vendorNotifier);
  const payablesFx = new PayablesFxService(drizzleDb, finance.engine, finance.fx);
  const vendorInsights = new VendorInsightsService(drizzleDb);
  const vendorPaymentService = new VendorPaymentService(drizzleDb, numbering, finance.engine, finance.vendorLedger, advancePayments, finance.fx, vendorNotifier);
  vendorPaymentService.useDestinationOpener((blob) => vendorProfileService.openBankNumber(blob));
  vendorPaymentService.useStatementMatcher(async (tx, ctx, lineId, entryId) => await finance.bankStatements.matchEntriesIn(tx, ctx, lineId, [entryId], 'vendor_payment'));
  const paymentEngine = createPaymentEngine({ db: drizzleDb, registry: paymentRegistry, payments, consumer: new FinanceC2bConsumer(drizzleDb, finance.receipts) });
  // The finance side asks banks for statements through the payment engine.
  finance.statementPulls.source = paymentEngine;
  paymentEngine.payoutConsumer = {
    finished: async (op) => {
      if (op.subjectType === 'refund') await finance.refunds.onAutomaticPayoutFinished(op);
      if (op.subjectType === 'vendor_payment') await vendorPaymentService.onAutomaticPayoutFinished(op);
    },
  };

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
    orderSla,
    stockLocations,
    stockLedger,
    stockAvailability: new StockAvailability(drizzleDb),
    stockShadow: new StockShadow(drizzleDb, stockLocations),
    stockSettings: new StockSettingsService(drizzleDb, companySettings),
    stockReservations: new StockReservations(drizzleDb, stockLedger, decisionLog),
    stockTransfers: new TransferService({ db: drizzleDb, ledger: stockLedger, numbering, decisionLog }),
    stockCounts: new CountService({ db: drizzleDb, ledger: stockLedger, numbering, decisionLog }),
    users,
    usersAdmin,
    accessControl,
    reports: new ReportsService(drizzleDb, accessControl),
    dimensions,
    units,
    unitWriter,
    dimensionSets,
    customers,
    vendors,
    vendorProfile: vendorProfileService,
    vendorReview: new VendorReviewService(drizzleDb, vendors, reasonCodes, vendorNotifier),
    vendorFiles,
    vendorNotifier,
    vendorBank: new VendorBankChangeService(drizzleDb, vendorNotifier),
    vendorLifecycle: new VendorLifecycleService(drizzleDb, finance.vendorLedger, reasonCodes, vendorNotifier),
    vendorExpiry: new VendorExpiryService(drizzleDb, vendorNotifier),
    vendorInvitations: new VendorInvitationService(drizzleDb, users, authTokens, vendorNotifier),
    vendorDocumentTypes: new VendorDocumentTypeService(drizzleDb),
    categories: new CategoryService(drizzleDb),
    prequal: new PrequalService(drizzleDb, vendorNotifier),
    prequalReview: new PrequalReviewService(drizzleDb, reasonCodes, vendorNotifier),
    prequalLifecycle,
    rfqs: rfqService,
    rfqPortal: new RfqPortalService(drizzleDb, prequalLifecycle, vendorNotifier),
    rfqEvaluation: new RfqEvaluationService(drizzleDb, rfqService, reasonCodes, vendorNotifier),
    purchaseOrders: purchaseOrderService,
    poPortal: new PurchaseOrderPortalService(drizzleDb, purchaseOrderService, rgnService),
    advances: advancePayments,
    rgns: rgnService,
    invoicePortal,
    supplierInvoices: new SupplierInvoiceService(drizzleDb, vendorNotifier),
    invoicePosting: new SupplierInvoicePostingService(drizzleDb, numbering, finance.engine, finance.postingSetup, finance.vendorLedger, finance.fx, vendorNotifier),
    vendorPayments: vendorPaymentService,
    paymentTerms: new PaymentTermsService(drizzleDb, vendors),
    creditMemoPortal: new CreditMemoPortalService(drizzleDb, numbering, vendorFiles, vendorNotifier),
    vendorInsights,
    rateLimits: new RateLimitService(drizzleDb),
    purchaseReturns: new PurchaseReturnService(drizzleDb, numbering, vendorNotifier),
    contracts: new ContractService(drizzleDb, numbering, vendorNotifier),
    landedCosts: new LandedCostService(drizzleDb, numbering),
    scorecards: new ScorecardService(drizzleDb, vendorInsights),
    edi: new EdiService(drizzleDb, invoicePortal),
    payablesFx,
    requisitions: new RequisitionService(drizzleDb, numbering, rfqService, purchaseOrderService, vendorNotifier),
    vendorRefunds: new VendorRefundService(drizzleDb, numbering, finance.engine, finance.vendorLedger, vendorNotifier),
    pettyCash: new PettyCashService(drizzleDb, numbering, finance.engine, finance.vendorLedger),
    creditMemos: new CreditMemoService(drizzleDb, finance.engine, finance.postingSetup, finance.vendorLedger, vendorNotifier),
    paymentRuns: new PaymentRunService(drizzleDb, numbering, vendorPaymentService, (blob) => vendorProfileService.openBankNumber(blob)),
    payablesReports: new PayablesReportService(drizzleDb, finance.vendorLedger, payablesFx),
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
