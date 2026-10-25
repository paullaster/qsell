'use client';

import { useState } from 'react';
import { attachOrderReferenceAction } from '@/server/domains/payments/activity-actions';
import { Field, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { has } from '@/lib/values';

/**
 * A paid order whose payment arrived without the platform's receipt number. The person adds it (with a reason
 * that is kept with their name) so the books can take the payment; the order's stage is not touched.
 */
export function OrderReferencePanel({ orderId, onChanged }: { orderId: string; onChanged: () => void }) {
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await attachOrderReferenceAction(orderId, reference, reason);
    setBusy(false);
    if (result.ok) {
      setReference('');
      setReason('');
      onChanged();
    } else {
      setError(result.error);
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      aria-label="Add the payment reference"
      className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4"
    >
      <p className="text-xs text-fg">
        <strong>This order is paid, but no payment reference was received.</strong> Add the provider&apos;s own
        transaction number (for M-Pesa, the receipt such as NLJ7RT61SV) so the payment can be recorded in the books.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={`ref-${orderId}`} label="Payment reference">
          <input
            id={`ref-${orderId}`}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            className={`${fieldClass} font-mono uppercase`}
            maxLength={40}
            autoComplete="off"
            required
          />
        </Field>
        <Field id={`ref-why-${orderId}`} label="Why you are adding it">
          <input
            id={`ref-why-${orderId}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Checked against the M-Pesa statement"
            className={fieldClass}
            maxLength={200}
            autoComplete="off"
            required
          />
        </Field>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-xs font-medium text-red-600">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy || !has(reference.trim()) || reason.trim().length < 10} className={primaryClass}>
        {busy ? 'Saving...' : 'Add payment reference'}
      </button>
    </form>
  );
}
