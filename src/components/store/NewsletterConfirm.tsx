'use client';

import { useState } from 'react';
import Link from 'next/link';
import { confirmNewsletterAction, unsubscribeNewsletterAction } from '@/server/domains/newsletter/actions';

/**
 * The page a newsletter link leads to. The link alone changes nothing (mail scanners open links); the person presses the
 * button, which is what actually confirms or unsubscribes.
 */
export function NewsletterConfirm({ token, mode }: { token: string; mode: 'confirm' | 'unsubscribe' }) {
  const [state, setState] = useState<{ done: boolean; ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const label = mode === 'confirm' ? 'Confirm subscription' : 'Unsubscribe';
  const run = async () => {
    setBusy(true);
    try {
      const result = await (mode === 'confirm' ? confirmNewsletterAction(token) : unsubscribeNewsletterAction(token));
      setState({ done: true, ok: result.ok, text: result.ok ? result.message : result.error });
    } catch {
      setState({ done: false, ok: false, text: 'We could not reach the shop. Please try again.' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-md space-y-4 py-16 text-center">
      <h1 className="text-2xl font-bold text-fg-strong">{mode === 'confirm' ? 'Confirm your subscription' : 'Unsubscribe'}</h1>
      {state?.done === true ? (
        <>
          <p role={state.ok ? 'status' : 'alert'} className="text-base text-fg">{state.text}</p>
          <Link href="/" className="inline-flex min-h-11 items-center rounded-lg bg-indigo-600 px-5 text-sm font-semibold text-white hover:bg-indigo-500">Back to the shop</Link>
        </>
      ) : (
        <>
          <p className="text-base text-fg-muted">{mode === 'confirm' ? 'Press the button to start receiving our news by email.' : 'Press the button to stop receiving our news by email.'}</p>
          {state === null ? null : <p role="alert" className="text-sm text-red-700 dark:text-red-400">{state.text}</p>}
          <button type="button" disabled={busy} onClick={() => void run()} className="min-h-11 cursor-pointer rounded-lg bg-indigo-600 px-6 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">{busy ? 'Please wait…' : label}</button>
        </>
      )}
    </div>
  );
}
