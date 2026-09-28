import type { Instrumentation } from 'next';

type DevWorkerGlobal = typeof globalThis & {
  __qsellDevQueueWorker?: boolean;
};

/** Start the Graphile worker alongside the Next.js dev server. */
export async function register() {
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

function firstHeader(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const errorObject = error instanceof Error ? error : null;
  const digest =
    typeof error === 'object' && error !== null && 'digest' in error ? String(error.digest) : null;
  const { recordApplicationError } = await import('@/server/observability/application-errors');
  await recordApplicationError({
    source: 'server',
    errorName: errorObject?.name ?? 'Error',
    message: errorObject?.message ?? String(error),
    stack: errorObject?.stack ?? null,
    digest,
    path: request.path.split('?')[0] ?? request.path,
    method: request.method,
    routePath: context.routePath,
    routeType: context.routeType,
    runtime: process.env.NEXT_RUNTIME ?? 'nodejs',
    requestId:
      firstHeader(request.headers['x-request-id']) ?? firstHeader(request.headers['x-vercel-id']),
    userAgent: firstHeader(request.headers['user-agent']),
    context: {
      routerKind: context.routerKind,
      renderSource: context.renderSource,
      revalidateReason: context.revalidateReason ?? null,
    },
  });
};
