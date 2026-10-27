import type { JobHelpers } from 'graphile-worker';
import { getContainer } from '@/server/di/container';
import { broadcastRealtime } from '@/server/realtime';
import { has } from '@/lib/values';
import { businessDate } from '@/server/kernel/numbering/business-date';

interface ProcessPaymentCallbackPayload {
  auditId: string;
  correlationId: string;
  provider: string;
  callbackToken?: string;
  callbackEventId?: string;
  rawPayload: string;
  headers: Record<string, string>;
}

interface ProcessWebhookPayload {
  auditId: string;
  correlationId: string;
  provider: string;
  operation: string;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
}

interface RetryFailedCallPayload {
  auditId: string;
  attempt: number;
}

/**
 * Worker task: a payment callback that was queued before payments were checked with the platform. It is
 * read and written down like any other callback, and the payment is verified, never taken on its word.
 */
export const processPaymentCallback = async (
  payload: ProcessPaymentCallbackPayload,
  helpers: JobHelpers,
) => {
  const { auditId, correlationId, provider, rawPayload, headers } = payload;
  helpers.logger.info(`Processing ${provider} callback (verified path)`, { auditId, correlationId });
  const container = getContainer();
  if (!has(payload.callbackToken)) {
    await container.paymentRecords.updateAuditLog(auditId, { errorCode: 'NO_TOKEN', errorMessage: 'The callback had no address secret, so it cannot be tied to a payment.' });
    return;
  }
  const reply = await container.paymentEngine.ingestAttemptCallback({
    token: payload.callbackToken,
    rawText: rawPayload,
    headers,
    sourceIp: null,
    https: true,
    method: 'POST',
  });
  await container.paymentRecords.updateAuditLog(auditId, { statusCode: reply.httpStatus, responsePayload: { verifiedPath: true, acknowledgement: reply.body } });
};

/** Worker task: ask the platform whether a payment is real; ask again later if it has not decided. */
export const providerVerifyAttempt = async (payload: { attemptId: string }, helpers: JobHelpers) => {
  const result = await getContainer().paymentEngine.verification.verifyAttempt(payload.attemptId);
  helpers.logger.info(`Payment ${payload.attemptId}: ${result.outcome}${has(result.reason) ? ` (${result.reason})` : ''}`);
};

/** Worker task: confirm money that arrived straight into a paybill or till. */
export const providerVerifyTransaction = async (payload: { transactionId: string }, helpers: JobHelpers) => {
  const result = await getContainer().paymentEngine.c2b.verify(payload.transactionId);
  helpers.logger.info(`Transaction ${payload.transactionId}: ${result.state}${has(result.reason) ? ` (${result.reason})` : ''}`);
};

/** Worker task: send an operation to the platform (or send it again). */
export const providerSendOperation = async (payload: { operationId: string }) => {
  await getContainer().paymentEngine.daraja.send(payload.operationId);
};

/** Worker cron task: pick up whatever a lost job or a restart left half done. */
export const providerSweep = async (_payload: unknown, helpers: JobHelpers) => {
  const r = await getContainer().paymentEngine.sweep();
  if (r.resent > 0 || r.claimed > 0) helpers.logger.info('Payment engine sweep', r);
};

/** Worker cron task: compare what Safaricom says it received with what we know. */
export const providerPullSweep = async (_payload: unknown, helpers: JobHelpers) => {
  const engine = getContainer().paymentEngine;
  for (const providerId of await engine.c2b.providersWithPull()) {
    const r = await engine.c2b.pullSweep(providerId);
    if (r.missing > 0 || r.found > 0) helpers.logger.info('Pull sweep', { providerId, ...r });
  }
};

/** Worker task: process a generic webhook (non-payment). */
export const processWebhook = async (payload: ProcessWebhookPayload, helpers: JobHelpers) => {
  helpers.logger.info(`Processing webhook ${payload.provider}.${payload.operation}`, {
    auditId: payload.auditId,
  });
  await getContainer().paymentRecords.updateAuditLog(payload.auditId, {
    callbackReceivedAt: new Date(),
  });
};

/** Worker task: retry a failed outbound call. */
export const retryFailedCall = async (
  payload: RetryFailedCallPayload,
  helpers: JobHelpers,
) => {
  helpers.logger.info(`Retrying failed call`, {
    auditId: payload.auditId,
    attempt: payload.attempt,
  });
  const audit = await getContainer().paymentRecords.getAuditLogById(payload.auditId);
  if (!audit) {
    helpers.logger.warn('Audit log not found for retry');
    return;
  }
  await getContainer().paymentRecords.updateAuditLog(payload.auditId, {
    retryCount: payload.attempt,
  });
};

/** Tokens are kept a week after they stop working, for support/audit questions. */
const AUTH_TOKEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Worker cron task: delete expired or used email-verification / password-reset tokens. */
export const purgeAuthTokens = async (_payload: unknown, helpers: JobHelpers) => {
  const removed = await getContainer().authTokens.purgeUnusable(
    new Date(Date.now() - AUTH_TOKEN_RETENTION_MS),
  );
  helpers.logger.info(`Purged ${removed} unusable auth tokens`);
};

/**
 * Worker task: turn a validated, staged CSV import into products. Resumable —
 * a retry continues from the first unprocessed row. When the queue gives up,
 * the import is marked failed so the admin sees it and can retry from the UI.
 */
export const processProductImport = async (payload: unknown, helpers: JobHelpers) => {
  const jobId =
    typeof payload === 'object' && payload !== null && 'jobId' in payload && typeof payload.jobId === 'string'
      ? payload.jobId
      : null;
  if (jobId === null) {
    helpers.logger.error('process-product-import: payload has no jobId');
    return;
  }
  const imports = getContainer().productImports;
  try {
    await imports.process(jobId, (message) => helpers.logger.info(message));
    await broadcastRealtime('inventory_update', { type: 'product_import_completed', importId: jobId });
  } catch (error) {
    if (helpers.job.attempts >= helpers.job.max_attempts) {
      await imports.markFailed(jobId, error instanceof Error ? error.message : 'Import failed');
    }
    throw error;
  }
};

/** Finished imports' staged rows are kept 30 days for progress and error reports. */
const PRODUCT_IMPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const purgeProductImports = async (_payload: unknown, helpers: JobHelpers) => {
  const removed = await getContainer().productImports.purgeFinishedBefore(
    new Date(Date.now() - PRODUCT_IMPORT_RETENTION_MS),
  );
  helpers.logger.info(`Purged ${removed} finished product imports`);
};

/** Worker cron task: drop never-attached uploads and long-deleted media files. */
export const purgeMedia = async (_payload: unknown, helpers: JobHelpers) => {
  const result = await getContainer().media.purge();
  helpers.logger.info(
    `Media purge: ${result.stalePendingRemoved} unattached, ${result.expiredDeletedRemoved} deleted, ${result.failed} failed`,
  );
};

/** Worker cron task: rebuilds the timeline of orders that existed before the timeline did, a batch at a time (it stops when none are left). */
export const orderStageBackfill = async (_payload: unknown, helpers: JobHelpers) => {
  const { OrderStages } = await import('@/server/domains/orders/stages');
  const { drizzleDb } = await import('@/server/db/drizzle/client');
  let total = 0;
  // A bounded number of batches per run, so a large history is rebuilt over a few runs without holding the worker.
  for (let pass = 0; pass < 20; pass += 1) {
    const done = await OrderStages.seedBatch(drizzleDb, 200);
    total += done;
    if (done === 0) break;
  }
  if (total > 0) helpers.logger.info(`Order timelines rebuilt: ${String(total)}`);
};

/** Worker cron task: removes refused and abandoned checkout attempts past their retention. */
export const purgeCheckoutAttempts = async (_payload: unknown, helpers: JobHelpers) => {
  const { CheckoutAttempts } = await import('@/server/domains/orders/checkout-attempts');
  const removed = await CheckoutAttempts.purge();
  if (removed > 0) helpers.logger.info(`Checkout attempts purged: ${String(removed)}`);
};

/** Worker cron task: hand approvals that are past their due time to the approver's own approver. */
export const sweepOverdueApprovals = async (_payload: unknown, helpers: JobHelpers) => {
  const r = await getContainer().approvals.sweepOverdue();
  if (r.escalated > 0 || r.stuck > 0 || r.failed > 0) {
    helpers.logger.info(
      `Approvals sweep: ${r.escalated} escalated, ${r.stuck} with nobody to escalate to, ${r.failed} failed`,
    );
  }
};

/** Worker cron task: lapse loyalty points that were not spent in time. */
export const expireLoyaltyPoints = async (_payload: unknown, helpers: JobHelpers) => {
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  const lapsed = await container.loyalty.expireDue(company.id);
  if (lapsed > 0) helpers.logger.info(`Loyalty expiry: ${lapsed} points lapsed`);
};

/** Worker cron task: make sure the monthly ledger partitions exist well ahead of time. */
export const financeEnsurePartitions = async (_payload: unknown, helpers: JobHelpers) => {
  const created = await getContainer().finance.maintenance.ensurePartitions();
  if (created > 0) helpers.logger.info(`Finance: created ${created} ledger partitions`);
};

/** Worker cron task: every stored shortcut figure must still agree with the record it summarises. */
export const financeIntegrityCheck = async (_payload: unknown, helpers: JobHelpers) => {
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  const report = await container.finance.maintenance.checkIntegrity(company.id);
  if (!report.ok) {
    helpers.logger.error(
      `FINANCE INTEGRITY ALERT: balance drift ${report.balanceDrift}, customer ledger drift ${report.customerDrift}, chain problems ${JSON.stringify(report.chainProblems)}`,
    );
    // Failing the job makes it retry and shows up in the worker's failed-job list.
    throw new Error('Finance integrity check found disagreements; see the audit trail.');
  }
};

/** Worker cron task: seal provider credentials under the current master key. */
export const resealProviderCredentials = async (_payload: unknown, helpers: JobHelpers) => {
  const r = await getContainer().payments.resealCredentials();
  if (r.resealed > 0) helpers.logger.info(`Credentials resealed under the current key: ${r.resealed}`);
  if (r.failed.length > 0) helpers.logger.error(`Credentials that could not be resealed: ${JSON.stringify(r.failed)}`);
};

/** Worker cron task: post queued sales events to the general ledger (also retries failed ones). */
export const financePostSales = async (_payload: unknown, helpers: JobHelpers) => {
  const r = await getContainer().finance.salesPosting.processDue(300);
  if (r.posted > 0 || r.failed > 0) helpers.logger.info(`Sales posting: ${r.posted} posted, ${r.failed} waiting to be fixed`);
};

/** Worker cron task: customer credit nobody used for as long as the policy allows lapses (once for each last use). */
export const walletExpiry = async (_payload: unknown, helpers: JobHelpers) => {
  const r = await getContainer().finance.creditAdjustments.expireDormant(new Date());
  if (r.expired > 0 || r.failed > 0) helpers.logger.info(`Wallet expiry: ${r.expired} lapsed, ${r.failed} could not be lapsed`);
};

/** Worker cron task: post changes in the value of stock to the general ledger (also retries failed ones). */
export const financePostInventory = async (_payload: unknown, helpers: JobHelpers) => {
  const r = await getContainer().finance.inventoryPosting.processDue(500);
  if (r.posted > 0 || r.failed > 0) helpers.logger.info(`Inventory posting: ${r.posted} posted, ${r.failed} waiting to be fixed`);
};

/** Worker cron task: a revaluation of an earlier day is undone, so only real differences stay in the books. */
export const fxReverseRevaluations = async (_payload: unknown, helpers: JobHelpers) => {
  const n = await getContainer().finance.fx.reverseDue();
  if (n > 0) helpers.logger.info(`Foreign-currency revaluation: ${n} undone`);
};

/** Worker cron task: gift cards past their date lose what is left on them (once each). */
export const expireGiftCards = async (_payload: unknown, helpers: JobHelpers) => {
  const r = await getContainer().giftCards.expireDue(new Date());
  if (r.expired > 0 || r.failed > 0) helpers.logger.info(`Gift card expiry: ${r.expired} written off, ${r.failed} could not be`);
};

/** Worker cron task: documents past their date are marked expired, and vendors are reminded at the days each type asks for. */
export const vendorDocumentExpiry = async (_payload: unknown, helpers: JobHelpers) => {
  const container = getContainer();
  const today = businessDate();
  const r = await container.vendorExpiry.run(today);
  if (r.expired > 0 || r.reminded > 0) helpers.logger.info(`Vendor documents: ${r.expired} expired, ${r.reminded} reminders sent`);
  // Documents first: a qualification whose blocking document just expired is suspended in the same run.
  const q = await container.prequalLifecycle.run(today);
  if (q.expired > 0 || q.suspended > 0 || q.restored > 0) helpers.logger.info(`Prequalification: ${q.expired} expired, ${q.suspended} suspended, ${q.restored} restored`);
};

/** Worker cron task: a changed vendor bank account starts to be used once its cool-off has passed. */
export const vendorBankPromote = async (_payload: unknown, helpers: JobHelpers) => {
  const n = await getContainer().vendorBank.promoteDue(new Date());
  if (n > 0) helpers.logger.info(`Vendor bank accounts: ${n} put into use after the cool-off`);
};

/** Worker cron task (nightly): the vendor ledger is compared with the payables and prepayments accounts; a difference is logged as an error. */
export const payablesCheck = async (_payload: unknown, helpers: JobHelpers) => {
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  const r = await container.payablesReports.runCheck(company.id, 'system');
  if (r.ok) helpers.logger.info('Payables check: the vendor ledger agrees with the books.');
  else helpers.logger.error(`Payables check: ${String(r.differences)} difference(s) between the vendor ledger and the books. See What we owe.`);
};

/** Worker cron task (nightly): a revaluation of what is owed in other currencies stands for a day and is undone the next. */
export const payablesFxReverse = async (_payload: unknown, helpers: JobHelpers) => {
  const done = await getContainer().payablesFx.reverseDue();
  if (done > 0) helpers.logger.info(`Payables: ${String(done)} revaluation(s) of foreign-currency balances undone.`);
};

/** Worker cron task (every few minutes): requests past their deadline close, and vendors that have not quoted are reminded. */
export const rfqDeadlines = async (_payload: unknown, helpers: JobHelpers) => {
  const container = getContainer();
  const now = new Date();
  const closed = await container.rfqs.closeDue(now);
  const reminded = await container.rfqs.remind(now);
  if (closed > 0 || reminded > 0) helpers.logger.info(`Requests for quotation: ${closed} closed at their deadline, ${reminded} reminders sent`);
};

export const tasks = {
  'process-payment-callback': processPaymentCallback,
  'process-webhook': processWebhook,
  'retry-failed-call': retryFailedCall,
  'purge-auth-tokens': purgeAuthTokens,
  'process-product-import': processProductImport,
  'purge-product-imports': purgeProductImports,
  'purge-media': purgeMedia,
  'order-stage-backfill': orderStageBackfill,
  'purge-checkout-attempts': purgeCheckoutAttempts,
  'sweep-overdue-approvals': sweepOverdueApprovals,
  'expire-loyalty-points': expireLoyaltyPoints,
  'finance-post-sales': financePostSales,
  'wallet-expiry': walletExpiry,
  'finance-post-inventory': financePostInventory,
  'fx-reverse-revaluations': fxReverseRevaluations,
  'expire-gift-cards': expireGiftCards,
  'finance-ensure-partitions': financeEnsurePartitions,
  'finance-integrity-check': financeIntegrityCheck,
  'reseal-provider-credentials': resealProviderCredentials,
  'provider-verify-attempt': providerVerifyAttempt,
  'provider-verify-transaction': providerVerifyTransaction,
  'provider-send-operation': providerSendOperation,
  'provider-sweep': providerSweep,
  'provider-pull-sweep': providerPullSweep,
  'vendor-document-expiry': vendorDocumentExpiry,
  'vendor-bank-promote': vendorBankPromote,
  'rfq-deadlines': rfqDeadlines,
  'payables-check': payablesCheck,
  'payables-fx-reverse': payablesFxReverse,
};
