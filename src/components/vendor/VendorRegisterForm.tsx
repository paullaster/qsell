'use client';

import Link from 'next/link';
import { useId, useState, useTransition } from 'react';
import { MailCheck } from 'lucide-react';
import { registerVendorAction, registerVendorBusinessForCurrentAccountAction } from '@/server/domains/vendors/portal-actions';
import { logoutAction } from '@/server/domains/auth/actions';
import { Field, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { checkRegistration, type VendorRegistration } from '@/lib/vendor-forms';
import { validatePassword } from '@/lib/passwordPolicy';
import { has } from '@/lib/values';

export function VendorRegisterForm({ currentCustomer }: { currentCustomer: { name: string; email: string } | null }) {
  const uid = useId();
  const [form, setForm] = useState<VendorRegistration>({ legalName: '', contactName: '', email: '', phone: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [businessRegistered, setBusinessRegistered] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof VendorRegistration>(key: K, value: VendorRegistration[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  const submit = (e: React.SyntheticEvent) => {
    e.preventDefault();
    const first = Object.values(checkRegistration(form, validatePassword(form.password)))[0];
    if (has(first)) {
      setError(first);
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await registerVendorAction(form);
      if (!res.ok) {
      setError(res.error);
      return;
    }
      setSentTo(form.email.trim().toLowerCase());
      set('password', '');
    });
  };

  if (businessRegistered) {
    return (
      <section className="mx-auto w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface-raised p-6" aria-live="polite">
        <MailCheck className="h-8 w-8 text-indigo-500" aria-hidden="true" />
        <h1 className="text-xl font-bold text-fg-strong">Vendor business registered</h1>
        <p className="text-sm text-fg-muted">{businessName} is linked to your existing qsell login. Sign out and sign in again to refresh your vendor portal access. Your password and customer account stay the same.</p>
        <form action={logoutAction}><input type="hidden" name="returnTo" value="/login" /><button type="submit" className={primaryClass}>Sign out and sign in</button></form>
      </section>
    );
  }

  if (sentTo !== null) {
    return (
      <section className="mx-auto w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface-raised p-6" aria-live="polite">
        <MailCheck className="h-8 w-8 text-indigo-500" aria-hidden="true" />
        <h1 className="text-xl font-bold text-fg-strong">Check your email</h1>
        <p className="text-sm text-fg-muted">
          If {sentTo} is new to qsell, a confirmation link is on its way. Open it to activate the new vendor login. If you already have a qsell account, sign in first and register the vendor business with that account.
        </p>
        <p className="text-xs text-fg-muted">If a buyer invited you, accept their invitation link so your login is linked to the correct vendor business.</p>
        <Link href="/login?callbackUrl=%2Fvendor" className={primaryClass}>Go to sign in</Link>
      </section>
    );
  }

  if (currentCustomer !== null) {
    return (
      <form onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          setError(null);
          const result = await registerVendorBusinessForCurrentAccountAction({ legalName: form.legalName, phone: form.phone });
          if (!result.ok) { setError(result.error); return; }
          setBusinessName(form.legalName.trim());
          setBusinessRegistered(true);
        });
      }} noValidate className="mx-auto w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface-raised p-6" aria-label="Register a vendor business">
        <div>
          <h1 className="text-xl font-bold text-fg-strong">Register a vendor business</h1>
          <p className="mt-1 text-sm text-fg-muted">You are signed in as {currentCustomer.name} ({currentCustomer.email}). This adds a supplier business to your existing login; it does not change your customer role or password.</p>
        </div>
        {error === null ? null : <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-600">{error}</p>}
        <Field id={`${uid}-existing-business`} label="Business legal name">
          <input id={`${uid}-existing-business`} value={form.legalName} onChange={(event) => set('legalName', event.target.value)} className={fieldClass} required autoComplete="organization" />
        </Field>
        <Field id={`${uid}-existing-phone`} label="Business phone (optional)">
          <input id={`${uid}-existing-phone`} type="tel" value={form.phone} onChange={(event) => set('phone', event.target.value)} className={fieldClass} autoComplete="tel" />
        </Field>
        <button type="submit" disabled={pending} className={`${primaryClass} w-full`}>{pending ? 'Registering…' : 'Register vendor business'}</button>
      </form>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="mx-auto w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface-raised p-6" aria-label="Register as a vendor">
      <div>
        <h1 className="text-xl font-bold text-fg-strong">Register your vendor business</h1>
        <p className="mt-1 text-sm text-fg-muted">This creates a vendor account for supplier onboarding, not a customer shopping account. You will complete a business profile and we will review it before you can quote or invoice. If a buyer sent you an invitation, accept that link instead.</p>
      </div>
      {error === null ? null : <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-600">{error}</p>}
      <Field id={`${uid}-biz`} label="Business legal name">
        <input id={`${uid}-biz`} value={form.legalName} onChange={(e) => set('legalName', e.target.value)} className={fieldClass} required autoFocus autoComplete="organization" />
      </Field>
      <Field id={`${uid}-name`} label="Your name">
        <input id={`${uid}-name`} value={form.contactName} onChange={(e) => set('contactName', e.target.value)} className={fieldClass} required autoComplete="name" />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={`${uid}-email`} label="Email">
          <input id={`${uid}-email`} type="email" value={form.email} onChange={(e) => set('email', e.target.value)} className={fieldClass} required autoComplete="email" />
        </Field>
        <Field id={`${uid}-phone`} label="Phone">
          <input id={`${uid}-phone`} type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} className={fieldClass} autoComplete="tel" />
        </Field>
      </div>
      <Field id={`${uid}-pw`} label="Password" hint="At least 8 characters.">
        <input id={`${uid}-pw`} type="password" value={form.password} onChange={(e) => set('password', e.target.value)} className={fieldClass} required autoComplete="new-password" />
      </Field>
      <button type="submit" disabled={pending} className={`${primaryClass} w-full`}>{pending ? 'Creating account…' : 'Create vendor account'}</button>
      <p className="text-center text-xs text-fg-muted">Already have a qsell account? <Link href="/login?callbackUrl=%2Fvendor%2Fregister" className="font-semibold text-indigo-600 hover:underline">Sign in first, then link your vendor business</Link></p>
    </form>
  );
}
