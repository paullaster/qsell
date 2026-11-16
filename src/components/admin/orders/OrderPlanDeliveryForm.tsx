'use client';

import { useId, useState } from 'react';
import { Truck } from 'lucide-react';
import { planOrderDeliveryAction } from '@/server/domains/delivery/document-actions';
import { Field, attempt, fieldClass, primaryClass } from '@/components/ui/screen-kit';

/**
 * For an order that never went through the shop's checkout (taken by staff, or converted from a quote), so it has no delivery plan and
 * cannot be delivered yet: how it goes and where. Its branch and its delivery charge are the ones already on the order.
 */
export function OrderPlanDeliveryForm({ orderId, prefill, onPlanned }: { orderId: string; prefill: { county: string; town: string; street: string } | null; onPlanned: () => void }) {
  const uid = useId();
  const [method, setMethod] = useState<'own_fleet' | 'courier'>('own_fleet');
  const [county, setCounty] = useState(prefill?.county ?? '');
  const [town, setTown] = useState(prefill?.town ?? '');
  const [area, setArea] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await attempt(planOrderDeliveryAction({ orderId, method, county, town, area, recipientName, recipientPhone, notes }));
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onPlanned();
  };

  return (
    <section aria-label="Plan the delivery" className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <h3 className="flex items-center gap-1.5 text-xs font-bold tracking-wider text-fg-strong uppercase">
        <Truck className="h-3.5 w-3.5 text-indigo-400" aria-hidden="true" />
        Plan the delivery
      </h3>
      <p className="text-xs text-fg-muted">
        This order was not placed through the shop, so it has no delivery plan yet. It goes from the branch on the order, for the delivery charge already on it
        {prefill === null || prefill.street === '' ? '' : `, to ${prefill.street}`}. Say how it goes and which town or area it is for; then it can be delivered from its screen like any other order.
      </p>
      <form
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset className="flex flex-wrap gap-4 sm:col-span-2">
          <legend className="sr-only">How it is delivered</legend>
          {(['own_fleet', 'courier'] as const).map((m) => (
            <label key={m} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-fg">
              <input type="radio" name={`${uid}-method`} className="h-4 w-4 accent-indigo-600" checked={method === m} onChange={() => setMethod(m)} />
              {m === 'own_fleet' ? 'Our own riders' : 'A courier'}
            </label>
          ))}
        </fieldset>
        <Field id={`${uid}-town`} label="Town or city">
          <input id={`${uid}-town`} value={town} onChange={(e) => setTown(e.target.value)} maxLength={120} className={fieldClass} autoComplete="off" />
        </Field>
        <Field id={`${uid}-county`} label="County or region">
          <input id={`${uid}-county`} value={county} onChange={(e) => setCounty(e.target.value)} maxLength={120} className={fieldClass} autoComplete="off" />
        </Field>
        <div className="sm:col-span-2">
          <Field id={`${uid}-area`} label="Estate or area (optional)" hint="Helps the dispatch board group deliveries that are close together.">
            <input id={`${uid}-area`} value={area} onChange={(e) => setArea(e.target.value)} maxLength={120} className={fieldClass} autoComplete="off" />
          </Field>
        </div>
        <Field id={`${uid}-rn`} label="Who receives it (optional)">
          <input id={`${uid}-rn`} value={recipientName} onChange={(e) => setRecipientName(e.target.value)} maxLength={120} className={fieldClass} autoComplete="off" />
        </Field>
        <Field id={`${uid}-rp`} label="Their phone">
          <input id={`${uid}-rp`} type="tel" value={recipientPhone} onChange={(e) => setRecipientPhone(e.target.value)} maxLength={40} className={`${fieldClass} font-mono`} autoComplete="off" />
        </Field>
        <div className="sm:col-span-2">
          <Field id={`${uid}-nt`} label="Note for the rider (optional)">
            <input id={`${uid}-nt`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} className={fieldClass} autoComplete="off" />
          </Field>
        </div>
        {error === null ? null : (
          <p role="alert" className="text-xs text-red-700 sm:col-span-2">
            {error}
          </p>
        )}
        <div className="sm:col-span-2">
          <button type="submit" className={primaryClass} disabled={busy}>
            {busy ? 'Planning…' : 'Plan the delivery'}
          </button>
        </div>
      </form>
    </section>
  );
}
