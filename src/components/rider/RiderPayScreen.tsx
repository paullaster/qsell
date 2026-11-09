'use client';

import { use } from 'react';
import Link from 'next/link';
import type { myPayAction } from '@/server/domains/delivery/rider-app-actions';
import { Chip } from '@/components/ui/screen-kit';

type Loaded = Awaited<ReturnType<typeof myPayAction>>;

const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Nairobi' });

/** A rider's own pay: what they are owed, what they earned this month, the latest entries and what was paid to them. */
export function RiderPayScreen({ payPromise }: { payPromise: ReturnType<typeof myPayAction> }) {
  const res: Loaded = use(payPromise);
  if (!res.ok) {
    return (
      <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        {res.error}
      </p>
    );
  }
  const pay = res.data;
  return (
    <div className="space-y-5">
      <div>
        <Link href="/rider" className="inline-flex min-h-11 items-center text-sm font-semibold text-indigo-600 dark:text-indigo-400">
          ← My runs
        </Link>
        <h1 className="text-xl font-bold text-fg-strong">My pay</h1>
      </div>
      <dl className="grid grid-cols-2 gap-3">
        <div className="space-y-0.5 rounded-xl border border-line bg-surface-raised p-3">
          <dt className="text-xs font-semibold text-fg-muted">Owed to me now</dt>
          <dd className="text-xl font-bold text-fg-strong">
            {pay.currency} {pay.owed}
          </dd>
          <dd className="text-xs text-fg-muted">Earned and not yet paid to me</dd>
        </div>
        <div className="space-y-0.5 rounded-xl border border-line bg-surface-raised p-3">
          <dt className="text-xs font-semibold text-fg-muted">Earned this month</dt>
          <dd className="text-xl font-bold text-fg-strong">
            {pay.currency} {pay.earnedThisMonth}
          </dd>
          <dd className="text-xs text-fg-muted">Since {pay.monthFrom}</dd>
        </div>
      </dl>

      <section aria-label="What I earned" className="space-y-2">
        <h2 className="text-sm font-bold text-fg-strong">What I earned</h2>
        {pay.entries.length === 0 ? (
          <p role="status" className="rounded-xl border border-line bg-surface-raised p-5 text-center text-sm text-fg-muted">
            Nothing yet. You earn when you deliver.
          </p>
        ) : (
          <ul className="space-y-2" aria-label="Pay list">
            {pay.entries.map((e) => (
              <li key={e.id} className="flex items-start justify-between gap-3 rounded-xl border border-line bg-surface-raised p-3 text-sm">
                <span className="min-w-0">
                  <span className="block font-semibold text-fg-strong">{e.words}</span>
                  <span className="block text-xs text-fg-muted">
                    {when(e.when)}
                    {e.deliveryNumber === null ? '' : ` · ${e.deliveryNumber}`}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className={`block font-mono font-semibold ${e.takenBack ? 'text-red-700 dark:text-red-300' : 'text-fg-strong'}`}>
                    {pay.currency} {e.amount}
                  </span>
                  {e.paid ? <Chip tone="green">Paid</Chip> : <Chip tone="amber">Not paid yet</Chip>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {pay.moreEntries ? <p className="text-xs text-fg-muted">Only the latest are shown here. Ask the office for older ones.</p> : null}
      </section>

      <section aria-label="What was paid to me" className="space-y-2">
        <h2 className="text-sm font-bold text-fg-strong">What was paid to me</h2>
        {pay.payouts.length === 0 ? (
          <p role="status" className="rounded-xl border border-line bg-surface-raised p-5 text-center text-sm text-fg-muted">
            Nothing has been paid to you yet.
          </p>
        ) : (
          <ul className="space-y-2" aria-label="Payout list">
            {pay.payouts.map((p) => (
              <li key={p.number} className="flex items-start justify-between gap-3 rounded-xl border border-line bg-surface-raised p-3 text-sm">
                <span className="min-w-0">
                  <span className="block font-mono font-semibold text-indigo-600 dark:text-indigo-400">{p.number}</span>
                  <span className="block text-xs text-fg-muted">
                    {p.paidOn} · {p.method}
                    {p.reference === null ? '' : ` · ${p.reference}`}
                  </span>
                </span>
                <span className="shrink-0 font-mono font-semibold text-fg-strong">
                  {pay.currency} {p.amount}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
