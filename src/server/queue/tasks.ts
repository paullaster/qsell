import type { JobHelpers } from 'graphile-worker';
import { getContainer } from '@/server/di/container';
import { ReconciliationEngine } from '@/server/domains/reconciliation/service';
import { InventoryReservationService } from '@/server/domains/inventory/reservation-service';
import { broadcastRealtime } from '@/server/realtime';
import type { PaymentProviderCode } from '@/server/domains/payments/types';

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
  helpers: { logger: any },
) => {
  const { auditId, correlationId, provider, rawPayload, headers } = payload;
  helpers.logger.info(`Processing ${provider} callback (verified path)`, { auditId, correlationId });
  const container = getContainer();
  if (!payload.callbackToken) {
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
export const providerVerifyAttempt = async (payload: { attemptId: string }, helpers: { logger: any }) => {
  const result = await getContainer().paymentEngine.verification.verifyAttempt(payload.attemptId);
  helpers.logger.info(`Payment ${payload.attemptId}: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`);
};

/** Worker task: confirm money that arrived straight into a paybill or till. */
export const providerVerifyTransaction = async (payload: { transactionId: string }, helpers: { logger: any }) => {
  const result = await getContainer().paymentEngine.c2b.verify(payload.transactionId);
  helpers.logger.info(`Transaction ${payload.transactionId}: ${result.state}${result.reason ? ` (${result.reason})` : ''}`);
};

/** Worker task: send an operation to the platform (or send it again). */
export const providerSendOperation = async (payload: { operationId: string }) => {
  await getContainer().paymentEngine.daraja.send(payload.operationId);
};

/** Worker cron task: pick up whatever a lost job or a restart left half done. */
export const providerSweep = async (_payload: unknown, helpers: { logger: any }) => {
  const r = await getContainer().paymentEngine.sweep();
  if (r.resent || r.claimed) helpers.logger.info('Payment engine sweep', r);
};

/** Worker cron task: compare what Safaricom says it received with what we know. */
export const providerPullSweep = async (_payload: unknown, helpers: { logger: any }) => {
  const engine = getContainer().paymentEngine;
  for (const providerId of await engine.c2b.providersWithPull()) {
    const r = await engine.c2b.pullSweep(providerId);
    if (r.missing || r.found) helpers.logger.info('Pull sweep', { providerId, ...r });
  }
};

/** Worker task: process a generic webhook (non-payment). */
export const processWebhook = async (payload: ProcessWebhookPayload, helpers: { logger: any }) => {
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
  helpers: { logger: any },
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

/** Worker cron task: hand approvals that are past their due time to the approver's own approver. */
export const sweepOverdueApprovals = async (_payload: unknown, helpers: JobHelpers) => {
  const r = await getContainer().approvals.sweepOverdue();
  if (r.escalated || r.stuck || r.failed) {
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
  if (r.posted || r.failed) helpers.logger.info(`Sales posting: ${r.posted} posted, ${r.failed} waiting to be fixed`);
};

export const tasks = {
  'process-payment-callback': processPaymentCallback,
  'process-webhook': processWebhook,
  'retry-failed-call': retryFailedCall,
  'purge-auth-tokens': purgeAuthTokens,
  'process-product-import': processProductImport,
  'purge-product-imports': purgeProductImports,
  'purge-media': purgeMedia,
  'sweep-overdue-approvals': sweepOverdueApprovals,
  'expire-loyalty-points': expireLoyaltyPoints,
  'finance-post-sales': financePostSales,
  'finance-ensure-partitions': financeEnsurePartitions,
  'finance-integrity-check': financeIntegrityCheck,
  'reseal-provider-credentials': resealProviderCredentials,
  'provider-verify-attempt': providerVerifyAttempt,
  'provider-verify-transaction': providerVerifyTransaction,
  'provider-send-operation': providerSendOperation,
  'provider-sweep': providerSweep,
  'provider-pull-sweep': providerPullSweep,
};
