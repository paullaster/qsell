'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { verifyEmailAction } from '@/server/domains/auth/actions';

type Outcome = { state: 'pending' } | { state: 'verified' } | { state: 'failed'; error: string };

/**
 * Confirms the address with a POST (server action) after the page loads rather
 * than during the GET render, so link scanners and prefetchers that fetch the
 * URL without running scripts don't consume the token.
 */
export function VerifyEmailStatus({ token }: { token: string }) {
  const [outcome, setOutcome] = useState<Outcome>({ state: 'pending' });
  const [, startTransition] = useTransition();
  // Tokens are single-use; guard against React re-running the effect.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    startTransition(async () => {
      try {
        const result = await verifyEmailAction({ token });
        setOutcome(result.ok ? { state: 'verified' } : { state: 'failed', error: result.error });
      } catch {
        setOutcome({
          state: 'failed',
          error: 'We couldn’t confirm your email right now. Check your connection and reload.',
        });
      }
    });
  }, [token]);

  return (
    <section
      className="mx-auto w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface-raised p-6"
      aria-live="polite"
    >
      {outcome.state === 'pending' ? (
        <>
          <Loader2 className="h-8 w-8 animate-spin text-indigo-500" aria-hidden="true" />
          <h1 className="text-xl font-bold text-fg-strong">Confirming your email…</h1>
        </>
      ) : null}
      {outcome.state === 'verified' ? (
        <>
          <CheckCircle2 className="h-8 w-8 text-emerald-500" aria-hidden="true" />
          <h1 className="text-xl font-bold text-fg-strong">Email confirmed</h1>
          <p className="text-sm text-fg-muted">Your account is active. Sign in to continue.</p>
        </>
      ) : null}
      {outcome.state === 'failed' ? (
        <>
          <XCircle className="h-8 w-8 text-red-500" aria-hidden="true" />
          <h1 className="text-xl font-bold text-fg-strong">We couldn’t confirm your email</h1>
          <p className="text-sm text-fg-muted" role="alert">
            {outcome.error}
          </p>
        </>
      ) : null}
      {outcome.state === 'pending' ? null : (
        <Link
          href="/login"
          className="flex min-h-12 w-full touch-manipulation items-center justify-center rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-500"
        >
          Sign in
        </Link>
      )}
    </section>
  );
}
