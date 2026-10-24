'use client';

import Link from 'next/link';
import { useId, useState, useTransition } from 'react';
import { MailCheck } from 'lucide-react';
import { registerVendorAction } from '@/server/domains/vendors/portal-actions';
import { Field, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { checkRegistration, type VendorRegistration } from '@/lib/vendor-forms';
import { validatePassword } from '@/lib/passwordPolicy';
import { has } from '@/lib/values';

export function VendorRegisterForm() {
  const uid = useId();
  const [form, setForm] = useState<VendorRegistration>({ legalName: '', contactName: '', email: '', phone: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
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

  if (sentTo !== null) {
    return (
      <section className="mx-auto w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface-raised p-6" aria-live="polite">
        <MailCheck className="h-8 w-8 text-indigo-500" aria-hidden="true" />
        <h1 className="text-xl font-bold text-fg-strong">Check your email</h1>
        <p className="text-sm text-fg-muted">
          We sent a confirmation link to <strong className="text-fg-strong">{sentTo}</strong>. Open it, then sign in to complete your business profile. Your application is reviewed before you can quote or invoice.
        </p>
        <Link href="/login?callbackUrl=%2Fvendor" className={primaryClass}>Go to sign in</Link>
      </section>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="mx-auto w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface-raised p-6" aria-label="Register as a vendor">
      <div>
        <h1 className="text-xl font-bold text-fg-strong">Become a vendor</h1>
        <p className="mt-1 text-sm text-fg-muted">Create an account for your business. You will complete your profile after you sign in, and we review it before you can quote or invoice.</p>
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
      <p className="text-center text-xs text-fg-muted">Already registered? <Link href="/login?callbackUrl=%2Fvendor" className="font-semibold text-indigo-600 hover:underline">Sign in</Link></p>
    </form>
  );
}
