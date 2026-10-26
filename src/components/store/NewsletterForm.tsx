'use client';

import { useId, useState } from 'react';
import { subscribeNewsletterAction } from '@/server/domains/newsletter/actions';

/** The footer's "get our news" form. The answer is the same for every address, so it cannot be used to find out who is on the list. */
export function NewsletterForm() {
  const id = useId();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (event: React.SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const result = await subscribeNewsletterAction({ email });
      setNotice({ ok: result.ok, text: result.ok ? result.message : result.error });
      if (result.ok) setEmail('');
    } catch {
      setNotice({ ok: false, text: 'We could not reach the shop. Please try again.' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} noValidate aria-label="Get our news by email" className="space-y-2">
      <label htmlFor={id} className="text-xs font-bold tracking-wider text-fg-strong uppercase">Get our news</label>
      <div className="flex gap-2">
        <input id={id} type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" maxLength={254} className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface-raised px-3 text-sm text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40" />
        <button type="submit" disabled={busy} className="min-h-11 shrink-0 cursor-pointer rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">{busy ? 'Sending…' : 'Subscribe'}</button>
      </div>
      <p className="text-xs text-fg-muted">We email you a link to confirm. You can unsubscribe at any time.</p>
      <div aria-live="polite">{notice === null ? null : <p role={notice.ok ? 'status' : 'alert'} className={`text-sm ${notice.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}>{notice.text}</p>}</div>
    </form>
  );
}
