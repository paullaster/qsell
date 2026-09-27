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
