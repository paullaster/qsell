'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { changeMyPinAction } from '@/server/domains/delivery/rider-app-actions';
import { PIN_LENGTH, pinProblem } from '@/lib/rider-pin';
import { Field, attempt, fieldClass, primaryClass } from '@/components/ui/screen-kit';

const digits = (value: string): string => value.replace(/\D/g, '').slice(0, PIN_LENGTH);

/** The rider chooses their own PIN: the first time (replacing the one the office gave) or later. */
export function RiderPinScreen({ first }: { first: boolean }) {
  const uid = useId();
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hint = next.length === PIN_LENGTH ? pinProblem(next) : null;
  const ready = current.length === PIN_LENGTH && next.length === PIN_LENGTH && confirm.length === PIN_LENGTH && hint === null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const r = await attempt(changeMyPinAction({ current, next, confirm }));
    if (r.ok) {
      router.replace('/rider');
      router.refresh();
      return;
    }
    setBusy(false);
    setError(r.error);
  };

  const box = `${fieldClass} min-h-12 text-center text-2xl tracking-[0.5em]`;
  return (
    <div className="mx-auto max-w-sm space-y-5">
      <div>
        {first ? null : (
          <Link href="/rider" className="inline-flex min-h-11 items-center text-sm font-semibold text-indigo-600 dark:text-indigo-400">
            ← My runs
          </Link>
        )}
        <h1 className="text-xl font-bold text-fg-strong">{first ? 'Choose your own PIN' : 'Change my PIN'}</h1>
        <p className="text-sm text-fg-muted">{first ? 'The office gave you a PIN to start with. Choose one only you know, then carry on.' : 'Choose a new 6-digit PIN. You need the one you have now.'}</p>
      </div>
      <form
        aria-label="Choose your PIN"
        className="space-y-4 rounded-xl border border-line bg-surface-raised p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field id={`${uid}-cur`} label={first ? 'The PIN the office gave you' : 'The PIN you have now'}>
          <input id={`${uid}-cur`} type="password" inputMode="numeric" pattern="[0-9]*" maxLength={PIN_LENGTH} autoComplete="current-password" className={box} value={current} onChange={(e) => setCurrent(digits(e.target.value))} required />
        </Field>
        <Field id={`${uid}-new`} label="Your new PIN" hint="6 digits. Not 123456, not one digit repeated, and not the end of your phone number.">
          <input id={`${uid}-new`} type="password" inputMode="numeric" pattern="[0-9]*" maxLength={PIN_LENGTH} autoComplete="new-password" className={box} value={next} onChange={(e) => setNext(digits(e.target.value))} required />
        </Field>
        <Field id={`${uid}-conf`} label="Your new PIN again">
          <input id={`${uid}-conf`} type="password" inputMode="numeric" pattern="[0-9]*" maxLength={PIN_LENGTH} autoComplete="new-password" className={box} value={confirm} onChange={(e) => setConfirm(digits(e.target.value))} required />
        </Field>
        {hint === null ? null : (
          <p role="status" className="text-sm text-amber-800 dark:text-amber-300">
            {hint}
          </p>
        )}
        {error === null ? null : (
          <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900">
            {error}
          </p>
        )}
        <button type="submit" className={`${primaryClass} min-h-12 w-full text-base`} disabled={busy || !ready}>
          {busy ? 'Saving…' : 'Save my PIN'}
        </button>
      </form>
    </div>
  );
}
