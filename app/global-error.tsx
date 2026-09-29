'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

export default function GlobalError({
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
    <html>
      <body>
        <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p>We couldn’t load this page. Please try again.</p>
          {error.digest && <p className="font-mono text-xs">Reference: {error.digest}</p>}
          <button type="button" onClick={reset}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
