import 'dotenv/config';
import { run, TaskList } from 'graphile-worker';
import { tasks } from './tasks';

/** Start the background worker (call from a dedicated process or Next.js serverless). */
export async function startWorker(): Promise<void> {
  const taskList = tasks as TaskList;

  const runner = await run({
    connectionString: process.env.DATABASE_URL,
    taskList,
    concurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 5)),
    pollInterval: Math.max(250, Number(process.env.WORKER_POLL_INTERVAL ?? 1000)),
    // Daily at 03:17 UTC (off the hour to avoid the top-of-hour cron pile-up).
    crontab: '17 3 * * * purge-auth-tokens',
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

/** Helper to run worker as a standalone script. */
if (require.main === module) {
  startWorker().catch((err) => {
    console.error('Worker failed:', err);
    process.exit(1);
  });
}
