'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { reportClientApplicationErrorAction } from '@/server/domains/application-errors/actions';

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const pathname = usePathname();

  useEffect(() => {
    console.error('[admin] route error', error);
    void reportClientApplicationErrorAction({
      errorName: error.name,
      message: error.message,
      stack: error.stack,
      digest: error.digest,
      path: pathname,
    }).catch((loggingError) => {
      console.error('[admin] failed to report route error', loggingError);
    });
  }, [error, pathname]);

  return (
    <div className="space-y-3 rounded-xl border border-red-900/50 bg-red-50 p-6">
      <h2 className="font-semibold text-fg-strong">Admin error</h2>
      <p className="text-sm text-fg-muted">{error.message}</p>
      {error.digest && (
        <p className="font-mono text-xs text-fg-muted">Error reference: {error.digest}</p>
      )}
      <Link
        href={
          error.digest
            ? `/admin/application-errors?search=${encodeURIComponent(error.digest)}`
            : '/admin/application-errors'
        }
        className="inline-block text-sm font-semibold text-indigo-700 underline dark:text-indigo-300"
      >
        Open application error logs
      </Link>
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
