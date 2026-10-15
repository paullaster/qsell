'use client';

import { useId, useState } from 'react';
import { updateNumberSeriesAction, type SeriesDetailView } from '@/server/kernel/numbering/actions';
import { attempt, cardClass, Field, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { MODE_CHOICES, SETTING_TOGGLES, seriesFormFrom, seriesPatch, withMode, type SeriesFormState } from '@/lib/number-series-forms';
import type { Report } from './NumberSeriesDetailClient';
import { ReasonField, reasonReady, type ReasonValue } from './ReasonField';

const noReason: ReasonValue = { code: '', text: '' };

export function SeriesSettingsCard({ data, report }: { data: SeriesDetailView; report: Report }) {
  const uid = useId();
  const s = data.series;
  const [form, setForm] = useState<SeriesFormState>(() => seriesFormFrom(s));
  const [reason, setReason] = useState(noReason);
  const [busy, setBusy] = useState(false);
  const fiscalLocked = data.fiscalKinds.length > 0;

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await attempt(updateNumberSeriesAction(s.id, seriesPatch(form), reason));
    if (await report(res, 'Series saved.')) setReason(noReason);
    setBusy(false);
  };

  return (
    <form onSubmit={(e) => void save(e)} className={`${cardClass} space-y-4`} aria-label="Series settings">
      <h3 className="text-base font-bold text-fg-strong">Settings</h3>
      <Field id={`${uid}-d`} label="Description">
        <input id={`${uid}-d`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={fieldClass} required />
      </Field>
      <fieldset>
        <legend className="mb-1 text-xs font-semibold text-fg">Numbering mode</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {MODE_CHOICES.map((m) => {
            const blocked = m.id === 'allow_gaps' && fiscalLocked;
            return (
              <label key={m.id} className={`flex min-h-10 items-start gap-3 rounded-lg border p-3 ${blocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${form.mode === m.id ? 'border-indigo-500 bg-indigo-600/15' : 'border-line-strong bg-surface-sunken/60'}`}>
                <input type="radio" name={`${uid}-mode`} disabled={blocked} checked={form.mode === m.id} onChange={() => setForm(withMode(form, m.id))} className="mt-1" />
                <span>
                  <span className="block text-sm font-semibold text-fg-strong">{m.label}</span>
                  <span className="block text-xs text-fg-muted">{m.hint}</span>
                </span>
              </label>
            );
          })}
        </div>
        {fiscalLocked ? <p className="mt-1 text-xs text-fg-muted">Locked to gap-free because it numbers {data.fiscalKinds.join(', ')}.</p> : null}
      </fieldset>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {SETTING_TOGGLES.map(([key, label]) => (
          <label key={key} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
            <input type="checkbox" className="h-5 w-5" checked={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.checked })} />
            {label}
          </label>
        ))}
        {form.mode === 'gap_free' ? (
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
            <input type="checkbox" className="h-5 w-5" checked={form.dateOrder} onChange={(e) => setForm({ ...form, dateOrder: e.target.checked })} />
            Numbers must follow document dates
          </label>
        ) : (
          <Field id={`${uid}-b`} label="Block size" hint="Numbers taken per trip to the database. Larger is faster; a restart can skip up to this many.">
            <input id={`${uid}-b`} type="number" min={1} max={10000} value={form.blockSize} onChange={(e) => setForm({ ...form, blockSize: e.target.value })} className={fieldClass} />
          </Field>
        )}
      </div>
      <ReasonField value={reason} onChange={setReason} />
      <button type="submit" disabled={busy || !reasonReady(reason)} className={primaryClass}>
        {busy ? 'Saving…' : 'Save settings'}
      </button>
    </form>
  );
}
