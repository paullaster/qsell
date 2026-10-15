'use client';

import { useId, useState } from 'react';
import { createTaxCategoryAction, updateTaxCategoryAction } from '@/server/domains/taxes/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { attempt, buttonClass, Field, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { ETIMS_TAX_CODES, TIMS_TAX_CODES } from '@/lib/kraTaxCodes';
import { submitWords } from '@/lib/form-words';
import { isTaxType, labelOfTaxType, taxFormFrom, taxPayload, type TaxForm } from '@/lib/tax-forms';
import type { Choice } from '@/lib/payment-options';
import type { TaxCategory } from '@/types/index';

interface Props {
  /** The rule being edited, or nothing for a new one. */
  tax: TaxCategory | null;
  onSaved: (saved: TaxCategory) => void;
  onCancel: () => void;
}

const codeChoice = (list: readonly { code: string; label: string }[], code: string): Choice | null => {
  const found = list.find((o) => o.code === code);
  return found === undefined ? null : { id: found.code, label: found.label };
};

/** One form for making and changing a tax rule: on the classification screen and in the product shortcut. */
export function TaxCategoryForm({ tax, onSaved, onCancel }: Props) {
  const uid = useId();
  const [form, setForm] = useState<TaxForm>(() => taxFormFrom(tax));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof TaxForm>(key: K, value: TaxForm[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const checked = taxPayload(form);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await attempt(tax === null ? createTaxCategoryAction(checked.payload) : updateTaxCategoryAction(tax.id, checked.payload));
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onSaved(res.data);
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" aria-label={tax === null ? 'New tax rule' : 'Edit tax rule'}>
      {error === null ? null : (
        <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-600">
          {error}
        </p>
      )}
      <Field id={`${uid}-name`} label="Tax schedule / category name">
        <input id={`${uid}-name`} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Standard VAT" className={fieldClass} required autoFocus />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id={`${uid}-code`} label="Tax code">
          <input id={`${uid}-code`} value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="e.g. VAT16" className={`${fieldClass} font-mono`} />
        </Field>
        <Field id={`${uid}-rate`} label="Rate (%)">
          <input id={`${uid}-rate`} type="number" min={0} step="0.01" inputMode="decimal" value={form.rate} onChange={(e) => set('rate', e.target.value)} className={fieldClass} required />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ChoicePicker label="KRA TIMS code" source="kra-tims-codes" choice={codeChoice(TIMS_TAX_CODES, form.timsCode)} onChoice={(c) => set('timsCode', c?.id ?? '')} placeholder="Not mapped" />
        <ChoicePicker label="KRA eTIMS code" source="kra-etims-codes" choice={codeChoice(ETIMS_TAX_CODES, form.etimsCode)} onChoice={(c) => set('etimsCode', c?.id ?? '')} placeholder="Not mapped" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ChoicePicker label="Fiscal tax type" source="tax-types" choice={{ id: form.type, label: labelOfTaxType(form.type) }} onChoice={(c) => set('type', isTaxType(c?.id) ? c.id : form.type)} clearable={false} />
        <div className="grid grid-cols-2 gap-3">
          <Field id={`${uid}-cc`} label="Country code">
            <input id={`${uid}-cc`} value={form.countryCode} onChange={(e) => set('countryCode', e.target.value)} placeholder="KE" maxLength={3} className={`${fieldClass} uppercase`} />
          </Field>
          <Field id={`${uid}-cn`} label="Country">
            <input id={`${uid}-cn`} value={form.countryName} onChange={(e) => set('countryName', e.target.value)} placeholder="Kenya" className={fieldClass} />
          </Field>
        </div>
      </div>
      <Field id={`${uid}-desc`} label="Description">
        <input id={`${uid}-desc`} value={form.description} onChange={(e) => set('description', e.target.value)} className={fieldClass} />
      </Field>
      <fieldset className="flex flex-wrap gap-x-5">
        <legend className="sr-only">How the rule is used</legend>
        {(
          [
            ['isInclusive', 'Selling prices include this tax'],
            ['isDefault', 'Use as the default rule'],
            ['isActive', 'Active'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
            <input type="checkbox" className="h-5 w-5" checked={form[key]} onChange={(e) => set(key, e.target.checked)} />
            {label}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={primaryClass}>
          {submitWords(busy, tax === null ? null : tax.id, 'Create tax rule')}
        </button>
        <button type="button" className={buttonClass} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
