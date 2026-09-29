import * as Sentry from '@sentry/nextjs';

type DevWorkerGlobal = typeof globalThis & {
  __qsellDevQueueWorker?: boolean;
};

/** Start the Graphile worker alongside the Next.js dev server. */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }

  if (process.env.NODE_ENV !== 'development' || process.env.NEXT_RUNTIME !== 'nodejs') return;

  const globalForWorker = globalThis as DevWorkerGlobal;
  if (globalForWorker.__qsellDevQueueWorker) return;
  globalForWorker.__qsellDevQueueWorker = true;

  try {
    const { startWorker } = await import('@/server/queue');
    await startWorker();
    console.info('[queue] Graphile worker started in development mode');
  } catch (error) {
    globalForWorker.__qsellDevQueueWorker = false;
    console.error('[queue] Failed to start development worker', error);
    throw error;
  }
}

export const onRequestError = Sentry.captureRequestError;
