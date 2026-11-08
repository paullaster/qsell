import { WorkerUtils, makeWorkerUtils } from 'graphile-worker';

/** Singleton worker utils for enqueueing jobs from API routes. */
let workerUtils: WorkerUtils | null = null;

export async function getWorkerUtils(): Promise<WorkerUtils> {
  if (workerUtils) return workerUtils;
  workerUtils = await makeWorkerUtils({
    connectionString: process.env.DATABASE_URL,
  });
  return workerUtils;
}

export async function closeWorkerUtils(): Promise<void> {
  if (workerUtils) {
    await workerUtils.release();
    workerUtils = null;
  }
}

/** Job payload types. */
export interface ProcessPaymentCallbackJob {
  auditId: string;
  correlationId: string;
  provider: string;
  callbackToken?: string;
  callbackEventId?: string;
  rawPayload: string;
  headers: Record<string, string>;
}

export interface ProcessWebhookJob {
  auditId: string;
  correlationId: string;
  provider: string;
  operation: string;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface RetryFailedCallJob {
  auditId: string;
  attempt: number;
}

/** Enqueue a payment callback for async processing. */
export async function enqueuePaymentCallback(job: ProcessPaymentCallbackJob): Promise<string> {
  const utils = await getWorkerUtils();
  const { id: jobId } = await utils.addJob('process-payment-callback', job, {
    queueName: 'payment-callbacks',
    maxAttempts: 5,
  });
  return jobId;
}

/** Enqueue a generic webhook for async processing. */
export async function enqueueWebhook(job: ProcessWebhookJob): Promise<string> {
  const utils = await getWorkerUtils();
  const { id: jobId } = await utils.addJob('process-webhook', job, {
    queueName: 'webhooks',
    maxAttempts: 5,
  });
  return jobId;
}

/** Enqueue retry for a failed outbound call. */
export async function enqueueRetry(job: RetryFailedCallJob): Promise<string> {
  const utils = await getWorkerUtils();
  const { id: jobId } = await utils.addJob('retry-failed-call', job, {
    queueName: 'retries',
    maxAttempts: 3,
  });
  return jobId;
}

/** Enqueue a mail to the shopper about their order. One job for each order and kind, so a repeated call sends one mail; the worker retries it if the mail server is down. */
export async function enqueueOrderEmail(orderId: string, kind: 'placed' | 'paid'): Promise<void> {
  const utils = await getWorkerUtils();
  await utils.addJob('shop-order-email', { orderId, kind }, { jobKey: `shop-order-email:${kind}:${orderId}`, jobKeyMode: 'preserve_run_at', maxAttempts: 8 });
}

/** Enqueue the reminder about one left cart. The key is the shopper and the state of the cart, so a repeated sweep never sends it twice. */
export async function enqueueCartReminder(userId: string, updatedAt: Date): Promise<void> {
  const utils = await getWorkerUtils();
  await utils.addJob('shop-cart-reminder', { userId, updatedAt: updatedAt.toISOString() }, { jobKey: `shop-cart-reminder:${userId}:${updatedAt.getTime()}`, jobKeyMode: 'preserve_run_at', maxAttempts: 6 });
}

/** Enqueue one slice of a newsletter. The key is the campaign and the place in the list, so a repeated call never sends a slice twice. */
export async function enqueueNewsletterSlice(step: { campaignId: string; subject: string; body: string; after: { k: string; id: string } | null; sent: number; failed: number }): Promise<void> {
  const utils = await getWorkerUtils();
  await utils.addJob('newsletter-slice', step, { jobKey: `newsletter:${step.campaignId}:${step.after === null ? 'start' : step.after.id}`, jobKeyMode: 'preserve_run_at', maxAttempts: 10 });
}
