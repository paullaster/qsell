'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { rescheduleByLinkAction } from '@/server/domains/delivery/tracking-actions';

/** The customer's own choice of another day for a delivery that could not be made, from their tracking page. */
export function RescheduleForm({ token, deliveryNumber }: { token: string; deliveryNumber: string }) {
  const id = useId();
  const router = useRouter();
  const [day, setDay] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      aria-label={`Choose another day for ${deliveryNumber}`}
      className="space-y-2 rounded-lg border border-line bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void (async () => {
          setBusy(true);
          setError(null);
          try {
            const r = await rescheduleByLinkAction({ token, deliveryNumber, day });
            if (r.ok) router.refresh();
            else setError(r.error);
          } catch {
            setError('We could not reach the shop. Check your connection and try again.');
          }
          setBusy(false);
        })();
      }}
    >
      <label htmlFor={id} className="block text-sm font-semibold text-fg-strong">
        Choose a day for us to try again
      </label>
      <p className="text-xs text-fg-muted">Any day from tomorrow, up to two weeks ahead. Please be reachable on your phone.</p>
      <div className="flex flex-wrap gap-2">
        <input id={id} type="date" required value={day} onChange={(e) => setDay(e.target.value)} className="min-h-11 rounded-lg border border-line bg-surface px-3 text-sm text-fg" />
        <button type="submit" disabled={busy || day === ''} className="min-h-11 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Try again on this day'}
        </button>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
    </form>
  );
}
