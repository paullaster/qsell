import { WorkerUtils, makeWorkerUtils } from 'graphile-worker';
import { drizzleDb } from '@/server/db/drizzle/client';
import { sql } from 'drizzle-orm';

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

/** Run graphile-worker migrations (call on startup). */
export async function ensureWorkerSchema(): Promise<void> {
  await drizzleDb.execute(sql`
    CREATE TABLE IF NOT EXISTS graphile_worker.migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      hash TEXT NOT NULL,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await drizzleDb.execute(sql`
    CREATE TABLE IF NOT EXISTS graphile_worker.jobs (
      id BIGSERIAL PRIMARY KEY,
      queue_name TEXT NOT NULL,
      task_identifier TEXT NOT NULL,
      payload JSONB NOT NULL,
      priority SMALLINT NOT NULL DEFAULT 0,
      run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 25,
      last_error TEXT,
      locked_at TIMESTAMPTZ,
      locked_by TEXT,
      failed_at TIMESTAMPTZ,
      revision INTEGER NOT NULL DEFAULT 0,
      key TEXT,
      flags TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await drizzleDb.execute(sql`
    CREATE INDEX IF NOT EXISTS jobs_queue_name_run_at_priority_id_idx
      ON graphile_worker.jobs (queue_name, run_at, priority DESC, id)
      WHERE locked_at IS NULL AND failed_at IS NULL;
  `);
}
