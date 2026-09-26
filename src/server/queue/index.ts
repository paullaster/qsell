import { run, TaskList } from 'graphile-worker';
import { tasks } from './tasks';
import { ensureWorkerSchema } from './worker';

/** Start the background worker (call from a dedicated process or Next.js serverless). */
export async function startWorker(): Promise<void> {
  await ensureWorkerSchema();

  const taskList = tasks as TaskList;

  const runner = await run({
    connectionString: process.env.DATABASE_URL,
    taskList,
    concurrency: 5,
    pollInterval: 1000,
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
