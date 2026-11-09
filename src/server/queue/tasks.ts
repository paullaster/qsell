import type { JobHelpers } from 'graphile-worker';
import { getContainer } from '@/server/di/container';
import { broadcastRealtime } from '@/server/realtime';
import { has } from '@/lib/values';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { postgresErrorSummary } from './postgres-error';

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

/** Worker cron task: send the messages customers are due about their deliveries, and try again those that could not be sent. */
export const deliveryMessagesSweep = async (_payload: unknown, helpers: JobHelpers) => {
  const sent = await getContainer().deliveryMessages.flush(50);
  if (sent > 0) helpers.logger.info(`Delivery messages sent: ${String(sent)}`);
};

/** A mail to a shopper about their order (placed, payment received). A failure is thrown so the worker tries again later. */
export const shopOrderEmail = async (payload: unknown, helpers: JobHelpers) => {
  const { orderId, kind } = (payload ?? {}) as { orderId?: unknown; kind?: unknown };
  if (typeof orderId !== 'string' || typeof kind !== 'string') return;
  const { sendOrderEmail } = await import('@/server/domains/orders/order-emails');
  const outcome = await sendOrderEmail(orderId, kind);
  helpers.logger.info(`Order mail ${kind} for ${orderId}: ${outcome}`);
};

/** Looks for carts left behind and queues one reminder for each. */
export const shopCartReminderSweep = async (_payload: unknown, helpers: JobHelpers) => {
  const { dueCartReminders } = await import('@/server/domains/cart/reminders');
  const { enqueueCartReminder } = await import('./worker');
  const due = await dueCartReminders(new Date());
  for (const cart of due) await enqueueCartReminder(cart.userId, cart.updatedAt);
  if (due.length > 0) helpers.logger.info(`Cart reminders queued: ${due.length}`);
};

/** The reminder to one shopper about the cart they left. A failure is thrown so the worker tries again later. */
export const shopCartReminder = async (payload: unknown, helpers: JobHelpers) => {
  const { userId, updatedAt } = (payload ?? {}) as { userId?: unknown; updatedAt?: unknown };
  if (typeof userId !== 'string' || typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))) return;
  const { sendCartReminder } = await import('@/server/domains/cart/reminders');
  const outcome = await sendCartReminder(userId, new Date(updatedAt), new Date());
  helpers.logger.info(`Cart reminder for ${userId}: ${outcome}`);
};

/** One slice of a newsletter; when more people are left it queues the next slice, and at the end it records how many were reached. */
export const newsletterSlice = async (payload: unknown, helpers: JobHelpers) => {
  const step = payload as { campaignId?: unknown; subject?: unknown; body?: unknown; after?: unknown; sent?: unknown; failed?: unknown };
  if (typeof step.campaignId !== 'string' || typeof step.subject !== 'string' || typeof step.body !== 'string') return;
  const after = typeof step.after === 'object' && step.after !== null ? (step.after as { k: string; id: string }) : null;
  const { sendCampaignSlice } = await import('@/server/domains/newsletter/campaign');
  const r = await sendCampaignSlice({ campaignId: step.campaignId, subject: step.subject, body: step.body, after, sent: Number(step.sent ?? 0), failed: Number(step.failed ?? 0) });
  if (r.next !== null) {
    const { enqueueNewsletterSlice } = await import('./worker');
    await enqueueNewsletterSlice(r.next);
    return;
  }
  const c = getContainer();
  const company = await c.companySettings.ensureSeeded();
  await c.decisionLog.record({ companyId: company.id, subject: { type: 'newsletter', id: step.campaignId }, action: 'newsletter.sent', actor: { type: 'job', id: 'newsletter-slice' }, from: '', to: `${String(r.sent)} sent, ${String(r.failed)} failed`, reason: { text: `Newsletter "${step.subject}" reached ${String(r.sent)} people; ${String(r.failed)} could not be sent.` } });
  helpers.logger.info(`Newsletter ${step.campaignId}: ${String(r.sent)} sent, ${String(r.failed)} failed`);
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
  try {
    const removed = await getContainer().productImports.purgeFinishedBefore(
      new Date(Date.now() - PRODUCT_IMPORT_RETENTION_MS),
    );
    helpers.logger.info(`Purged ${removed} finished product imports`);
  } catch (error) {
    helpers.logger.error(`purge-product-imports database diagnostics: ${postgresErrorSummary(error)}`);
    throw error;
  }
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
  const resolved = await getContainer().orderSla.purge(new Date());
  if (resolved > 0) helpers.logger.info(`Resolved late-order records purged: ${String(resolved)}`);
};

/** Worker cron task: brings every product's stock and history into the per-location ledger, a slice at a time, while the shadow is on. */
export const stockBackfill = async (_payload: unknown, helpers: JobHelpers) => {
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  const status = await container.stockShadow.status(company.id);
  if (!status.shadowWrite || status.backfillDoneAt !== null) return;
  const r = await container.stockShadow.backfillBatch(company.id);
  helpers.logger.info(`Stock backfill: ${String(r.done)} products${r.finished ? ', finished' : ''}`);
};

/**
 * Worker cron task: stock holds whose time has run out are given back, and an order that was still unpaid is marked failed, with the
 * reason on its timeline. Only holds that were given a time (shop orders paid at once, when the company sets a hold time) can run out.
 */
/** Shop orders to be paid at once, still unpaid after the hold time, in the old counters: their stock is given back and the order marked failed with the reason. */
async function expireCounterHolds(helpers: JobHelpers): Promise<void> {
  const container = getContainer();
  const minutes = (await container.stockSettings.get()).unpaidHoldMinutes;
  if (minutes <= 0) return;
  const { drizzleDb } = await import('@/server/db/drizzle/client');
  const { orders } = await import('@/server/db/drizzle/schema');
  const { and, eq, inArray, lt } = await import('drizzle-orm');
  const { ONLINE_PAYMENT_METHODS, InventoryReservationService } = await import('@/server/domains/inventory/reservation-service');
  const { OrderStages } = await import('@/server/domains/orders/stages');
  const due = await drizzleDb
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.status, 'pending'), inArray(orders.paymentStatus, ['unpaid', 'pending_verification']), inArray(orders.paymentMethod, [...ONLINE_PAYMENT_METHODS]), lt(orders.createdAt, new Date(Date.now() - minutes * 60_000))))
    .limit(100);
  for (const order of due) {
    try {
      await InventoryReservationService.releaseOrder(order.id, 'expired: the hold ran out', 'stock-reservation-expiry');
      await OrderStages.move(drizzleDb, order.id, 'payment_failed', 'failed', { source: 'worker', reasonCode: 'hold_expired', message: 'The stock held for this order ran out before it was paid.' });
    } catch (error) {
      helpers.logger.error(`Stock hold expiry (counters): order ${order.id} could not be released: ${String(error)}`);
    }
  }
  if (due.length > 0) helpers.logger.info(`Stock holds expired (counters): ${String(due.length)} orders`);
}

export const stockReservationExpiry = async (_payload: unknown, helpers: JobHelpers) => {
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  // Without the per-location ledger a hold has no time of its own, so the orders that waited longer than the company allows are found here.
  if (!(await container.stockSettings.isLedgerMode())) await expireCounterHolds(helpers);
  const expired = await container.stockReservations.expireDue(company.id, new Date());
  if (expired.length === 0) return;
  const { OrderStages } = await import('@/server/domains/orders/stages');
  const { drizzleDb } = await import('@/server/db/drizzle/client');
  const { orders } = await import('@/server/db/drizzle/schema');
  const { eq } = await import('drizzle-orm');
  let failed = 0;
  for (const ref of expired) {
    if (ref.refType !== 'order') continue;
    try {
      const [order] = await drizzleDb.select({ status: orders.status, paymentStatus: orders.paymentStatus }).from(orders).where(eq(orders.id, ref.refId)).limit(1);
      if (order?.status !== 'pending' || !['unpaid', 'pending_verification'].includes(order.paymentStatus)) continue;
      await OrderStages.move(drizzleDb, ref.refId, 'stock_released', 'succeeded', { ref: { type: 'stock_settlement', id: ref.refId }, source: 'worker', reasonCode: 'hold_expired', message: 'The stock held for this order ran out before it was paid.', detail: { released: ref.quantity } });
      const moved = await OrderStages.move(drizzleDb, ref.refId, 'payment_failed', 'failed', {
        source: 'worker',
        reasonCode: 'hold_expired',
        message: 'The stock held for this order ran out before it was paid.',
        detail: { releasedQuantity: ref.quantity },
      });
      if (moved.recorded) failed++;
    } catch (error) {
      helpers.logger.error(`Stock hold expiry: order ${ref.refId} could not be marked: ${String(error)}`);
    }
  }
  helpers.logger.info(`Stock holds expired: ${String(expired.length)} documents, ${String(failed)} orders marked failed`);
};

/** Worker cron task: proves the per-location ledger agrees with the old stock counters (while it is being filled and once it is the truth), keeps the result, and says so loudly when it does not. */
export const stockShadowCheck = async (_payload: unknown, helpers: JobHelpers) => {
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  const status = await container.stockCutover.status(company.id);
  if (status.mode === 'off' || (status.mode === 'shadow' && !status.backfillDone)) return;
  const { ok, report } = await container.stockCutover.check(company.id, 'nightly', null);
  if (!ok) helpers.logger.error(`Stock ledger MISMATCH: ${JSON.stringify({ ...report, sample: report.sample.slice(0, 10) })}`);
  else helpers.logger.info(`Stock ledger agrees for ${String(report.products)} products`);
};

/** Worker cron task: orders that waited too long in a stage are recorded, mailed, escalated, and closed when they move on. */
export const orderSlaSweep = async (_payload: unknown, helpers: JobHelpers) => {
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  const r = await container.orderSla.sweep(company.id, new Date());
  if (r.raised > 0 || r.escalated > 0 || r.resolved > 0) {
    helpers.logger.info(`Order targets: ${String(r.raised)} late, ${String(r.escalated)} escalated, ${String(r.resolved)} moved on`);
  }
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

/** Worker cron task: post rider pay that was earned to the general ledger (also retries failed ones). */
export const deliveryCostPost = async (_payload: unknown, helpers: JobHelpers) => {
  const r = await getContainer().deliveryCostBooks.processDue(200);
  if (r.posted > 0 || r.failed > 0) helpers.logger.info(`Rider pay posting: ${r.posted} posted, ${r.failed} waiting to be fixed`);
};

/** Worker cron task: deliveries that reached at risk, late or still late against the window they were promised are raised once each. */
export const deliverySlaScan = async (_payload: unknown, helpers: JobHelpers) => {
  const c = getContainer();
  const r = await c.deliverySla.scan();
  if (r.raised > 0) helpers.logger.info(`Delivery lateness: ${r.raised} raised from ${r.checked} watched`);
  // The mails the lateness caused go out after the scan, and a mail server that is down never stops the scan.
  const mailed = await c.deliverySlaNotices.flush(20).catch((error: unknown) => {
    helpers.logger.error(`Delivery lateness mails: ${String(error)}`);
    return 0;
  });
  if (mailed > 0) helpers.logger.info(`Delivery lateness mails sent: ${String(mailed)}`);
};

/** Worker cron task: parcels are booked with their couriers, asked about on the road and cancelled when their delivery is; a courier that is down never stops the rest. */
export const courierSync = async (_payload: unknown, helpers: JobHelpers) => {
  const r = await getContainer().courierSync.run();
  if (r.booked + r.cancelled + r.failed > 0) helpers.logger.info(`Couriers: ${r.booked} booked, ${r.polled} asked, ${r.cancelled} cancelled, ${r.failed} to try again or fix`);
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

/**
 * Worker cron task: the shop shows prices at the books' exchange rate of the day. A rate set ahead for tomorrow starts when the day
 * starts, with nobody saving anything, so this brings the shop's rates in line every hour (it writes only what differs).
 */
export const currencySyncRates = async (_payload: unknown, helpers: JobHelpers) => {
  const { CurrencyDomainService } = await import('@/server/domains/currencies/service');
  const changed = await CurrencyDomainService.syncWithBooks();
  if (changed.length > 0) helpers.logger.info(`Shop rates brought in line with the books: ${changed.join(', ')}`);
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
  'order-sla-sweep': orderSlaSweep,
  'stock-backfill': stockBackfill,
  'stock-shadow-check': stockShadowCheck,
  'stock-reservation-expiry': stockReservationExpiry,
  'sweep-overdue-approvals': sweepOverdueApprovals,
  'expire-loyalty-points': expireLoyaltyPoints,
  'finance-post-sales': financePostSales,
  'delivery-cost-post': deliveryCostPost,
  'delivery-sla-scan': deliverySlaScan,
  'courier-sync': courierSync,
  'wallet-expiry': walletExpiry,
  'finance-post-inventory': financePostInventory,
  'fx-reverse-revaluations': fxReverseRevaluations,
  'currency-sync-rates': currencySyncRates,
  'expire-gift-cards': expireGiftCards,
  'finance-ensure-partitions': financeEnsurePartitions,
  'finance-integrity-check': financeIntegrityCheck,
  'reseal-provider-credentials': resealProviderCredentials,
  'provider-verify-attempt': providerVerifyAttempt,
  'provider-verify-transaction': providerVerifyTransaction,
  'provider-send-operation': providerSendOperation,
  'provider-sweep': providerSweep,
  'delivery-messages-sweep': deliveryMessagesSweep,
  'shop-order-email': shopOrderEmail,
  'shop-cart-reminder-sweep': shopCartReminderSweep,
  'shop-cart-reminder': shopCartReminder,
  'newsletter-slice': newsletterSlice,
  'provider-pull-sweep': providerPullSweep,
  'vendor-document-expiry': vendorDocumentExpiry,
  'vendor-bank-promote': vendorBankPromote,
  'rfq-deadlines': rfqDeadlines,
  'payables-check': payablesCheck,
  'payables-fx-reverse': payablesFxReverse,
};
