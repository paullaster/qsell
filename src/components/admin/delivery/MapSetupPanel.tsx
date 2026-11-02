'use client';

import { useId, useState } from 'react';
import { Field, Message, attempt, buttonClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { GEO_CONFIG_FIELDS, GEO_PROVIDERS, type GeoProviderId } from '@/lib/geo-providers';
import { saveGeoSettingsAction, tryGeoSettingsAction } from '@/server/domains/geo/actions';

export interface Saved {
  driver: GeoProviderId;
  config: Record<string, unknown>;
  version: number;
}

interface Step {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

/** A setting kept as a list (country codes) is shown as the text it was typed as. */
const asText = (value: unknown): string => {
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' ? value : '';
};

/**
 * Sets a map service up: its settings, a button that tries it for real without saving, and a reason that is kept with the change.
 * Nothing changes until it is saved; a service that fails its try can still be saved, because the system falls back to the
 * built-in estimate rather than stopping a sale, but the screen says what failed first.
 */
export function MapSetupPanel({ driver, current, version, onSaved, onCancel }: { driver: GeoProviderId; current: Record<string, unknown>; version: number; onSaved: (saved: Saved) => void; onCancel: () => void }) {
  const uid = useId();
  const info = GEO_PROVIDERS[driver];
  const fields = GEO_CONFIG_FIELDS[driver];
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, asText(current[f.key])])));
  const [reason, setReason] = useState('');
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [busy, setBusy] = useState<'try' | 'save' | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const change = (key: string, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    setSteps(null);
  };

  const tryIt = async () => {
    setBusy('try');
    setNotice(null);
    const res = await attempt(tryGeoSettingsAction({ driver, config: values }));
    setBusy(null);
    if (!res.ok) {
      setSteps(null);
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setSteps(res.data.steps);
  };

  const save = async () => {
    setBusy('save');
    setNotice(null);
    const res = await attempt(saveGeoSettingsAction({ driver, config: values, expectedVersion: version, reason }));
    setBusy(null);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    onSaved({ driver: res.data.driver, config: res.data.config, version: res.data.version });
  };

  const failed = steps?.filter((s) => !s.ok) ?? [];
  return (
    <form
      aria-label={`Set up ${info.name}`}
      className="space-y-4 rounded-xl border border-indigo-500 bg-surface-raised p-4 sm:p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3 className="text-base font-semibold text-fg-strong">Set up {info.name}</h3>
      {fields.length === 0 ? <p className="text-sm text-fg-muted">This service needs no settings.</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.key} className={f.kind === 'url' ? 'sm:col-span-2' : ''}>
            <Field id={`${uid}-${f.key}`} label={f.required ? f.label : `${f.label} (optional)`} hint={f.hint}>
              <input id={`${uid}-${f.key}`} type={f.kind === 'email' ? 'email' : 'text'} inputMode={f.kind === 'url' ? 'url' : undefined} value={values[f.key] ?? ''} onChange={(e) => change(f.key, e.target.value)} placeholder={f.placeholder} className={fieldClass} autoComplete="off" required={f.required} />
            </Field>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void tryIt()}>
          {busy === 'try' ? 'Trying it…' : 'Try it now'}
        </button>
        <p className="text-xs text-fg-muted">Finds a place, names a pin and measures a road with these settings. Nothing is saved. It can take a few seconds because the free servers are asked one request at a time.</p>
        {steps === null ? null : (
          <ul aria-label="What the try found" className="space-y-1 text-sm">
            {steps.map((s) => (
              <li key={s.name} className={s.ok ? 'text-fg' : 'text-red-700'}>
                <span aria-hidden="true">{s.ok ? '✓' : '✗'}</span> <span className="sr-only">{s.ok ? 'Worked: ' : 'Failed: '}</span>
                <strong>{s.name}</strong> {s.ms > 0 ? `(${String(s.ms)} ms)` : ''}: {s.detail}
              </li>
            ))}
          </ul>
        )}
        {failed.length > 0 ? <p role="alert" className="text-sm text-amber-700">Something failed. You can still save it: delivery keeps working on the built-in estimate while it fails. Check the settings first.</p> : null}
      </div>

      <Field id={`${uid}-reason`} label="Why? (kept with the change)">
        <input id={`${uid}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} className={fieldClass} maxLength={300} autoComplete="off" />
      </Field>
      <Message notice={notice} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryClass} disabled={busy !== null || reason.trim().length < 5}>
          {busy === 'save' ? 'Saving…' : `Use ${info.name}`}
        </button>
        <button type="button" className={buttonClass} onClick={onCancel} disabled={busy !== null}>
          Cancel
        </button>
      </div>
    </form>
  );
}
