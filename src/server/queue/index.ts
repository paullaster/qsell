import 'dotenv/config';
import { run, TaskList } from 'graphile-worker';
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
      // Approvals are time-sensitive, so this one runs every five minutes.
      '*/5 * * * * sweep-overdue-approvals',
    ].join('\n'),
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await runner.stop();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await runner.stop();
    process.exit(0);
  });
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
  startWorker().catch((err) => {
    console.error('Worker failed:', err);
    process.exit(1);
  });
}
