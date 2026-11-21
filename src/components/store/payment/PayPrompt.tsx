'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { callsFor, type RecoveryMode } from './payment-recovery-calls';

/**
 * Shown on an order that is waiting for its payment: it asks the shop (never the browser) whether the order can still be paid, and if so
 * offers the way to finish it. Nothing is drawn for an order that is paid, cancelled or paid some other way.
 */
export function PayPrompt({ mode, href }: { mode: RecoveryMode; href: string }) {
  const [due, setDue] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void callsFor(mode)
      .options()
      .then((r) => {
        if (live) setDue(r.ok && r.data.payable.ok && r.data.methods.length > 0);
      })
      .catch(() => {
        if (live) setDue(false);
      });
    return () => {
      live = false;
    };
  }, [mode]);
  if (due !== true) return null;
  return (
    <section aria-label="Payment not received" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 sm:p-5">
      <p className="flex items-start gap-2 text-sm font-semibold text-fg-strong">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
        <span>We have not received the payment for this order yet.</span>
      </p>
      <p className="mt-1 text-sm text-fg">If you have already paid, you can tell us the code from your payment message. Otherwise you can pay again.</p>
      <Link href={href} className="mt-3 inline-flex min-h-11 items-center justify-center rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700">
        Complete this order
      </Link>
    </section>
  );
}
