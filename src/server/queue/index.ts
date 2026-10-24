import 'dotenv/config';
import { run, type TaskList } from 'graphile-worker';
import { tasks } from './tasks';
import { getWorkerUtils } from './worker';

/** Start the background worker (call from a dedicated process or Next.js serverless). */
export async function startWorker(): Promise<void> {
  const taskList = tasks as TaskList;

  await releaseImportLocksFromDeadWorkers();

  const runner = await run({
    connectionString: process.env.DATABASE_URL,
    taskList,
    concurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 5)),
    pollInterval: Math.max(250, Number(process.env.WORKER_POLL_INTERVAL ?? 1000)),
    // Daily, off the hour to avoid the top-of-hour cron pile-up (UTC).
    crontab: [
      '17 3 * * * purge-auth-tokens',
      '27 3 * * * purge-product-imports',
      '37 3 * * * purge-media',
      '47 3 * * * expire-loyalty-points',
      // Sales reach the ledger within a minute; failures retry with a growing delay.
      '* * * * * finance-post-sales',
      '* * * * * finance-post-inventory',
      '7 3 * * * finance-ensure-partitions',
      '12 4 * * * wallet-expiry',
      '20 * * * * fx-reverse-revaluations',
      '32 4 * * * expire-gift-cards',
      '57 3 * * * finance-integrity-check',
      '2 4 * * * reseal-provider-credentials',
      // Approvals are time-sensitive, so this one runs every five minutes.
      '*/5 * * * * sweep-overdue-approvals',
      // Payments: pick up anything a lost job left half done, and compare with what Safaricom has received.
      '* * * * * provider-sweep',
      '*/10 * * * * provider-pull-sweep',
      // Vendors: documents past their date, and bank changes whose cool-off has passed.
      '22 5 * * * vendor-document-expiry',
      '41 * * * * vendor-bank-promote',
    ].join('\n'),
  });

  // Graceful shutdown
  const shutdown = () => {
    void runner.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * A worker killed mid-job (OOM, SIGKILL) leaves its job locked, and Graphile only
 * reclaims such locks after 4 hours — a product import would stall that long.
 * Production runs one worker service, so any import lock that exists while a
 * new process starts belongs to a dead one. Imports are resumable and
 * row-idempotent, so releasing a lock can never create duplicates.
 */
async function releaseImportLocksFromDeadWorkers(): Promise<void> {
  const utils = await getWorkerUtils();
  await utils.migrate();
  const workerIds = await utils.withPgClient(async (client) => {
    const { rows } = await client.query<{ locked_by: string }>(
      `select distinct locked_by from graphile_worker.jobs
       where task_identifier = 'process-product-import' and locked_by is not null`,
    );
    return rows.map((row) => row.locked_by);
  });
  if (workerIds.length > 0) {
    await utils.forceUnlockWorkers(workerIds);
    console.warn(`[worker] released product-import locks held by stopped workers: ${workerIds.join(', ')}`);
  }
}

/** Helper to run worker as a standalone script. */
if (require.main === module) {
  startWorker().catch((err: unknown) => {
    console.error('Worker failed:', err);
    process.exit(1);
  });
}
