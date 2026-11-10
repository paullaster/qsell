'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { riderPinSignInAction } from '@/server/domains/delivery/rider-sign-in-actions';
import { normalizePhone } from '@/lib/rider-pin';
import { Field, fieldClass, primaryClass } from '@/components/ui/screen-kit';

/** The rider app's own sign-in: a phone number and a 6-digit PIN, on big keys for a phone. */
export function RiderSignIn() {
  const uid = useId();
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = normalizePhone(phone) !== null && /^\d{6}$/.test(pin);

  const submit = async () => {
    setBusy(true);
    setError(null);
    let result: Awaited<ReturnType<typeof riderPinSignInAction>>;
    try {
      result = await riderPinSignInAction({ phone, pin });
    } catch {
      result = { ok: false, error: 'Something went wrong. Check your signal and try again.' };
    }
    if (result.ok) {
      router.replace('/rider');
      router.refresh();
      return;
    }
    setBusy(false);
    setPin('');
    setError(result.error);
  };

  return (
    <div className="mx-auto max-w-sm space-y-5">
      <div>
        <h1 className="text-xl font-bold text-fg-strong">Sign in to ride</h1>
        <p className="text-sm text-fg-muted">Use your phone number and the 6-digit PIN you were given.</p>
      </div>
      <form
        aria-label="Sign in with your phone number"
        className="space-y-4 rounded-xl border border-line bg-surface-raised p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field id={`${uid}-phone`} label="Phone number">
          <input id={`${uid}-phone`} type="tel" inputMode="tel" autoComplete="username" className={`${fieldClass} min-h-12 text-lg`} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0712 345 678" required />
        </Field>
        <Field id={`${uid}-pin`} label="PIN">
          <input id={`${uid}-pin`} type="password" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="current-password" className={`${fieldClass} min-h-12 text-center text-2xl tracking-[0.5em]`} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} required />
        </Field>
        {error === null ? null : (
          <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900">
            {error}
          </p>
        )}
        <button type="submit" className={`${primaryClass} min-h-12 w-full text-base`} disabled={busy || !ready}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="text-center text-sm text-fg-muted">
        Forgot your PIN? Ask the office for a new one.
        <br />
        <Link href="/login?callbackUrl=%2Frider" className="inline-flex min-h-11 items-center font-semibold text-indigo-600 dark:text-indigo-400">
          Sign in with email and password instead
        </Link>
      </p>
    </div>
  );
}
