'use client';

import { useId, useState } from 'react';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { cardClass, Field, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { branchOfScope, canRegister, emptyRegisterForm, registerFormFor, registerPayload, type RegisterForm } from '@/lib/etims-forms';
import type { Choice } from '@/lib/payment-options';
import { has } from '@/lib/values';

type Payload = Extract<ReturnType<typeof registerPayload>, { ok: true }>['payload'];

interface Props {
  /** "company", or the id of an independent branch. */
  scope: string;
  disabled: boolean;
  onRegister: (input: Payload) => void;
}

const CODE_FIELDS = [
  ['q', 'qtyUnitCode', 'Quantity unit code', 'U'],
  ['k', 'pkgUnitCode', 'Package unit code', 'CT'],
  ['c', 'itemClassCode', 'Item classification code', '99000000'],
] as const;

export function EtimsRegisterForm({ scope, disabled, onRegister }: Props) {
  const uid = useId();
  const [product, setProduct] = useState<Choice | null>(null);
  const [form, setForm] = useState<RegisterForm>(emptyRegisterForm);
  const [problem, setProblem] = useState<string | null>(null);

  const choose = (next: Choice | null) => {
    setProduct(next);
    setForm(registerFormFor(next));
    setProblem(null);
  };

  const submit = (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (product === null) return;
    const checked = registerPayload(branchOfScope(scope), product, form);
    if (!checked.ok) {
      setProblem(checked.error);
      return;
    }
    onRegister(checked.payload);
    choose(null);
  };

  return (
    <form aria-label="Register item" className={`${cardClass} space-y-4`} onSubmit={submit}>
      <h3 className="text-base font-bold text-fg-strong">Register a product</h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <ChoicePicker label="Product" source="etims-registrable-products" filters={{ scope }} choice={product} onChoice={choose} placeholder="Search a product by name or SKU…" required />
          {product !== null && !canRegister(product) ? <p role="alert" className="mt-1 text-xs text-red-700">This product has no eTIMS tax code, so it cannot be registered.</p> : null}
        </div>
        {CODE_FIELDS.map(([key, field, label, placeholder]) => (
          <Field key={key} id={`${uid}-${key}`} label={label}>
            <input id={`${uid}-${key}`} required value={form[field]} placeholder={placeholder} onChange={(e) => setForm({ ...form, [field]: e.target.value })} className={`${fieldClass} font-mono`} />
          </Field>
        ))}
        <Field id={`${uid}-s`} label="Opening stock">
          <input id={`${uid}-s`} type="number" min={0} step={1} required value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} className={fieldClass} />
        </Field>
      </div>
      {has(problem) ? (
        <p role="alert" className="text-sm text-red-700">
          {problem}
        </p>
      ) : null}
      <button type="submit" disabled={disabled || !canRegister(product)} className={primaryClass}>
        Register with KRA
      </button>
    </form>
  );
}
