'use client';

import { useId, useState } from 'react';
import { createCustomerAction, type CreatedCustomer } from '@/server/domains/customers/create-action';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { attempt, buttonClass, Field, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { accountTypeOf, emptyCustomerForm, labelOfAccountType, newCustomerPayload, type CustomerForm } from '@/lib/customer-forms';
import { metaValue } from '@/lib/receipt-form';
import { submitWords } from '@/lib/form-words';
import { firstFilled } from '@/lib/values';
import type { Choice } from '@/lib/payment-options';

interface Props {
  onSaved: (customer: CreatedCustomer) => void;
  onCancel: () => void;
}

/** The quick form for a new customer: the details the pickers need, with the full card left to the customers screen. */
export function CustomerCreateForm({ onSaved, onCancel }: Props) {
  const uid = useId();
  const [form, setForm] = useState<CustomerForm>(emptyCustomerForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof CustomerForm>(key: K, value: CustomerForm[K]) => setForm((prev) => ({ ...prev, [key]: value }));
  const credit = form.accountType === 'credit';

  /** A profile brings its account type and terms; they can still be changed after. */
  const chooseProfile = (c: Choice | null) =>
    setForm((prev) => {
      if (c === null) return { ...prev, profileId: '', profileLabel: '' };
      return {
        ...prev,
        profileId: c.id,
        profileLabel: c.label,
        accountType: accountTypeOf(metaValue(c.meta, 'accountType')),
        creditLimit: firstFilled(metaValue(c.meta, 'creditLimit')) ?? prev.creditLimit,
        paymentTermDays: firstFilled(metaValue(c.meta, 'paymentTermDays')) ?? prev.paymentTermDays,
        transmitInvoicesToKra: metaValue(c.meta, 'transmit') === '1',
      };
    });

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const checked = newCustomerPayload(form);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await attempt(createCustomerAction(form));
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onSaved(res.data);
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4" aria-label="New customer">
      {error === null ? null : (
        <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-600">
          {error}
        </p>
      )}
      <Field id={`${uid}-name`} label="Customer name">
        <input id={`${uid}-name`} value={form.name} onChange={(e) => set('name', e.target.value)} className={fieldClass} required autoFocus autoComplete="off" />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={`${uid}-email`} label="Email">
          <input id={`${uid}-email`} type="email" value={form.email} onChange={(e) => set('email', e.target.value)} className={fieldClass} autoComplete="off" />
        </Field>
        <Field id={`${uid}-phone`} label="Phone">
          <input id={`${uid}-phone`} type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} className={fieldClass} autoComplete="off" />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ChoicePicker label="Customer profile" source="customer-profiles" choice={form.profileId === '' ? null : { id: form.profileId, label: form.profileLabel }} onChoice={chooseProfile} placeholder="No profile" />
        <ChoicePicker label="Account type" source="customer-account-types" choice={{ id: form.accountType, label: labelOfAccountType(form.accountType) }} onChoice={(c) => set('accountType', accountTypeOf(c?.id))} clearable={false} />
      </div>
      {credit ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field id={`${uid}-limit`} label="Credit limit">
            <input id={`${uid}-limit`} type="number" min={0} step="0.01" inputMode="decimal" value={form.creditLimit} onChange={(e) => set('creditLimit', e.target.value)} className={fieldClass} required />
          </Field>
          <Field id={`${uid}-terms`} label="Payment terms (days)">
            <input id={`${uid}-terms`} type="number" min={0} max={365} step={1} inputMode="numeric" value={form.paymentTermDays} onChange={(e) => set('paymentTermDays', e.target.value)} className={fieldClass} required />
          </Field>
        </div>
      ) : null}
      <Field id={`${uid}-pin`} label="Buyer KRA PIN" hint="Needed on tax invoices for businesses.">
        <input id={`${uid}-pin`} value={form.buyerKraPin} onChange={(e) => set('buyerKraPin', e.target.value)} placeholder="A123456789Z" className={`${fieldClass} font-mono uppercase`} autoComplete="off" />
      </Field>
      <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
        <input type="checkbox" className="h-5 w-5" checked={form.transmitInvoicesToKra} onChange={(e) => set('transmitInvoicesToKra', e.target.checked)} />
        Send this customer’s invoices to KRA
      </label>
      <Field id={`${uid}-notes`} label="Notes">
        <input id={`${uid}-notes`} value={form.notes} onChange={(e) => set('notes', e.target.value)} className={fieldClass} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={primaryClass}>
          {submitWords(busy, null, 'Create customer')}
        </button>
        <button type="button" className={buttonClass} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
