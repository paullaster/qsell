'use client';

import { useId } from 'react';
import { Smartphone } from 'lucide-react';
import { nationalPhone, sameMobile, toKenyanMsisdn } from '@/lib/phone';

const inputClass =
  'min-h-11 w-full rounded-lg border border-line bg-surface px-3.5 py-2 font-mono text-sm text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40';

/**
 * The phone a payment is made from. It starts as the contact number, but a customer may pay from any line (a spouse's, a work
 * line, a till they borrowed), so it can be changed here without touching the contact number.
 */
export function PayFromField({
  value,
  contactPhone,
  onChange,
  label = 'Pay from this number',
}: {
  value: string;
  contactPhone: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const different = value.trim() !== '' && !sameMobile(value, contactPhone);
  return (
    <div className="space-y-1.5 rounded-xl border border-line bg-surface-raised p-3.5">
      <label htmlFor={id} className="flex items-center gap-2 text-sm font-medium text-fg">
        <Smartphone className="h-4 w-4 text-emerald-600" aria-hidden="true" />
        {label}
      </label>
      <input id={id} type="tel" inputMode="tel" autoComplete="off" value={value} onChange={(event) => onChange(event.target.value)} aria-describedby={hintId} className={inputClass} placeholder={toKenyanMsisdn(contactPhone) === null ? '07XX XXX XXX' : nationalPhone(contactPhone)} />
      <p id={hintId} className="text-xs text-fg-muted">
        The payment prompt goes to this phone. It can be any line you have, not only the number you gave above. Leave it empty to use your contact number.
        {different ? ' We keep this number with your order, as the one the payment was made from.' : ''}
      </p>
      {different ? (
        <button type="button" onClick={() => onChange('')} className="min-h-10 cursor-pointer text-xs font-medium text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400">
          Use my contact number instead
        </button>
      ) : null}
    </div>
  );
}
