'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

/** A problem on a shop page. The shopper gets plain words and a way to try again; the details go to the team, never to the screen. */
export default function StoreError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <div role="alert" className="mx-auto max-w-md space-y-4 py-16 text-center">
      <h1 className="text-2xl font-bold text-fg-strong">Something went wrong</h1>
      <p className="text-base text-fg-muted">We could not show this page just now. Please try again in a moment.</p>
      <button type="button" onClick={reset} className="min-h-11 cursor-pointer rounded-lg bg-indigo-600 px-5 text-sm font-semibold text-white hover:bg-indigo-500">
        Try again
      </button>
    </div>
  );
}
