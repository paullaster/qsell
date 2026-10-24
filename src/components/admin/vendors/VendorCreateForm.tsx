'use client';

import { useId, useState } from 'react';
import { createVendorAction } from '@/server/domains/vendors/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { attempt, buttonClass, Field, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { checkVendorCreation, emptyVendorCreation, VENDOR_TYPES, type VendorCreation } from '@/lib/vendor-forms';
import { submitWords } from '@/lib/form-words';
import { has } from '@/lib/values';

interface Props {
  /** Whether this person may make a vendor active at once (decided on the server when the page was made). */
  canActivate: boolean;
  onSaved: (vendor: { id: string; label: string }) => void;
  onCancel: () => void;
}

/** The form to add a vendor on the company's behalf; the vendor completes its own profile in the portal. */
export function VendorCreateForm({ canActivate, onSaved, onCancel }: Props) {
  const uid = useId();
  const [form, setForm] = useState<VendorCreation>(emptyVendorCreation);
  const [activate, setActivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof VendorCreation>(key: K, value: VendorCreation[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const first = Object.values(checkVendorCreation(form))[0];
    if (has(first)) {
      setError(first);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await attempt(createVendorAction(form, activate));
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onSaved({ id: res.data.id, label: form.legalName.trim() });
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4" aria-label="New vendor">
      {error === null ? null : <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-600">{error}</p>}
      <Field id={`${uid}-name`} label="Legal name">
        <input id={`${uid}-name`} value={form.legalName} onChange={(e) => set('legalName', e.target.value)} className={fieldClass} required autoFocus autoComplete="off" />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={`${uid}-trading`} label="Trading name">
          <input id={`${uid}-trading`} value={form.tradingName} onChange={(e) => set('tradingName', e.target.value)} className={fieldClass} autoComplete="off" />
        </Field>
        <ChoicePicker label="Kind of business" source="vendor-types" choice={{ id: form.vendorType, label: VENDOR_TYPES.find((t) => t.id === form.vendorType)?.label ?? form.vendorType }} onChoice={(c) => set('vendorType', c?.id ?? 'company')} clearable={false} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={`${uid}-email`} label="Email">
          <input id={`${uid}-email`} type="email" value={form.email} onChange={(e) => set('email', e.target.value)} className={fieldClass} required autoComplete="off" />
        </Field>
        <Field id={`${uid}-phone`} label="Phone">
          <input id={`${uid}-phone`} type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} className={fieldClass} autoComplete="off" />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={`${uid}-tax`} label="Tax ID (KRA PIN)" hint="Two vendors cannot share one.">
          <input id={`${uid}-tax`} value={form.taxId} onChange={(e) => set('taxId', e.target.value)} className={`${fieldClass} font-mono uppercase`} autoComplete="off" />
        </Field>
        <Field id={`${uid}-country`} label="Country">
          <input id={`${uid}-country`} value={form.country} onChange={(e) => set('country', e.target.value)} className={fieldClass} autoComplete="off" />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={`${uid}-terms`} label="Payment terms (days)">
          <input id={`${uid}-terms`} type="number" min={0} max={365} step={1} inputMode="numeric" value={form.paymentTermDays} onChange={(e) => set('paymentTermDays', e.target.value)} className={fieldClass} required />
        </Field>
        <Field id={`${uid}-cur`} label="Currency" hint="Leave empty for the company's currency.">
          <input id={`${uid}-cur`} value={form.currency} onChange={(e) => set('currency', e.target.value)} maxLength={3} className={`${fieldClass} uppercase`} autoComplete="off" />
        </Field>
      </div>
      <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
        <input type="checkbox" className="h-5 w-5" checked={form.approvedExpenseVendor} onChange={(e) => set('approvedExpenseVendor', e.target.checked)} />
        Approved expense vendor (may invoice without a purchase order)
      </label>
      {canActivate ? (
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
          <input type="checkbox" className="h-5 w-5" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
          Make this vendor active now, without the vendor review
        </label>
      ) : null}
      <Field id={`${uid}-notes`} label="Notes">
        <textarea id={`${uid}-notes`} value={form.notes} onChange={(e) => set('notes', e.target.value)} className={fieldClass} rows={2} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={primaryClass}>{submitWords(busy, null, 'Add vendor')}</button>
        <button type="button" className={buttonClass} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
