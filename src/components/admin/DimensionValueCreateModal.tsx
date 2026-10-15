'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createDimensionValueAction } from '@/server/domains/dimensions/actions';
import { publishCustomerShortcut } from '@/components/admin/customer-shortcuts';
import { RouteModal } from '@/components/admin/RouteModal';
import { attempt, cardClass, Field, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { emptyValueForm, valuePayload } from '@/lib/dimension-forms';

export function DimensionValueCreateModal({
  presentation,
  dimensionId,
  dimensionCode,
  fieldName,
}: {
  presentation: 'intercepted' | 'page';
  dimensionId: string;
  dimensionCode: string;
  fieldName: string;
}) {
  const router = useRouter();
  const uid = useId();
  const [form, setForm] = useState(emptyValueForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (presentation === 'intercepted') router.back();
    else router.push(`/admin/settings/dimensions/${dimensionId}`);
  };

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const checked = valuePayload(form);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await attempt(createDimensionValueAction({ dimensionId, ...checked.payload }));
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (presentation === 'intercepted') {
      publishCustomerShortcut({ kind: 'dimensionValue', fieldName, value: { code: res.data.code, name: res.data.name } });
      router.back();
    } else {
      router.push(`/admin/settings/dimensions/${dimensionId}`);
      router.refresh();
    }
  };

  const set = (key: 'code' | 'name' | 'description', value: string) => setForm((p) => ({ ...p, [key]: value }));
  const body = (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" aria-label={`New ${dimensionCode} value`}>
      <p className="text-xs text-fg-muted">Add a value, then return to the customer form.</p>
      {error === null ? null : (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <Field id={`${uid}-code`} label="Code">
        <input id={`${uid}-code`} className={fieldClass} value={form.code} onChange={(e) => set('code', e.target.value)} required autoFocus />
      </Field>
      <Field id={`${uid}-name`} label="Name">
        <input id={`${uid}-name`} className={fieldClass} value={form.name} onChange={(e) => set('name', e.target.value)} required />
      </Field>
      <Field id={`${uid}-desc`} label="Description">
        <input id={`${uid}-desc`} className={fieldClass} value={form.description} onChange={(e) => set('description', e.target.value)} />
      </Field>
      <button type="submit" disabled={busy} className={`${primaryClass} w-full`}>
        {busy ? 'Saving…' : 'Save value'}
      </button>
    </form>
  );

  if (presentation === 'intercepted') return <RouteModal title={`New ${dimensionCode} value`} onClose={close}>{body}</RouteModal>;
  return (
    <div className={`${cardClass} max-w-lg space-y-3`}>
      <h2 className="text-base font-bold text-fg-strong">New {dimensionCode} value</h2>
      {body}
    </div>
  );
}
