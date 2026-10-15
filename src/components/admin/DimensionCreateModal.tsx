'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createDimensionAction } from '@/server/domains/dimensions/actions';
import { globalDimensionFieldName, shortcutDimensionFieldName } from '@/server/domains/dimensions/projection';
import { publishCustomerShortcut } from '@/components/admin/customer-shortcuts';
import { RouteModal } from '@/components/admin/RouteModal';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { attempt, cardClass, Field, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { DIMENSION_KINDS, quickDimensionPayload, type DimensionKind } from '@/lib/dimension-forms';
import type { Choice } from '@/lib/payment-options';

const KIND_CHOICES: Record<DimensionKind, Choice> = { global: { id: 'global', label: 'Global dimension' }, shortcut: { id: 'shortcut', label: 'Shortcut dimension' } };

export function DimensionCreateModal({ presentation }: { presentation: 'intercepted' | 'page' }) {
  const router = useRouter();
  const uid = useId();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [dimensionNo, setDimensionNo] = useState('1');
  const [kind, setKind] = useState<Choice | null>(KIND_CHOICES.global);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (presentation === 'intercepted') router.back();
    else router.push('/admin/settings/dimensions');
  };

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const chosen: DimensionKind = DIMENSION_KINDS.find((k) => k.id === kind?.id)?.id ?? 'global';
    const checked = quickDimensionPayload({ code, name, dimensionNo, kind: chosen });
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await attempt(createDimensionAction(checked.payload));
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const created = res.data;
    if (presentation === 'intercepted') {
      const resolvedNo = created.dimensionNo ?? checked.payload.dimensionNo;
      publishCustomerShortcut({
        kind: 'dimension',
        field: {
          fieldName: chosen === 'global' ? globalDimensionFieldName(resolvedNo) : shortcutDimensionFieldName(resolvedNo),
          dimensionId: created.id,
          dimensionCode: created.code,
          kind: chosen,
          values: [],
        },
      });
      router.back();
    } else {
      router.push(`/admin/settings/dimensions/${created.id}`);
      router.refresh();
    }
  };

  const form = (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" aria-label="Create dimension">
      <p className="text-xs text-fg-muted">Add a dimension, then return to the customer form.</p>
      {error === null ? null : (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <Field id={`${uid}-code`} label="Code">
        <input id={`${uid}-code`} className={fieldClass} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
      </Field>
      <Field id={`${uid}-name`} label="Name">
        <input id={`${uid}-name`} className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>
      <Field id={`${uid}-no`} label="Number">
        <input id={`${uid}-no`} className={fieldClass} type="number" min={1} step={1} inputMode="numeric" value={dimensionNo} onChange={(e) => setDimensionNo(e.target.value)} required />
      </Field>
      <ChoicePicker label="Use on customers as" source="dimension-kinds" choice={kind} onChoice={setKind} clearable={false} required />
      <button type="submit" disabled={busy} className={`${primaryClass} w-full`}>
        {busy ? 'Saving…' : 'Save dimension'}
      </button>
    </form>
  );

  if (presentation === 'intercepted') return <RouteModal title="Create dimension" onClose={close}>{form}</RouteModal>;
  return (
    <div className={`${cardClass} max-w-lg space-y-3`}>
      <h2 className="text-base font-bold text-fg-strong">Create dimension</h2>
      {form}
    </div>
  );
}
