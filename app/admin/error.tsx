'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="space-y-3 rounded-xl border border-red-900/50 bg-red-50 p-6">
      <h2 className="font-semibold text-fg-strong">Admin error</h2>
      <p className="text-sm text-fg-muted">{error.message}</p>
      {error.digest && (
        <p className="font-mono text-xs text-fg-muted">Error reference: {error.digest}</p>
      )}
      <button
        type="button"
        onClick={reset}
        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white"
      >
        Retry
      </button>
    </div>
  );
}
