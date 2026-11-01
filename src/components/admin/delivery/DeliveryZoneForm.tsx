'use client';

import { useId, useState } from 'react';
import { createDeliveryZoneAction, updateDeliveryZoneAction, type ZoneView } from '@/server/domains/delivery/actions';
import { Field, Message, attempt, buttonClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

/** Adds a delivery zone, or changes one. The server checks everything again and refuses a stale edit; this only saves a round trip. */
export function DeliveryZoneForm({ zone, autoFocus, onCancel, onSaved }: { zone: ZoneView | null; autoFocus?: boolean; onCancel: () => void; onSaved: (saved: { code: string }) => void }) {
  const uid = useId();
  const [code, setCode] = useState(zone?.code ?? '');
  const [name, setName] = useState(zone?.name ?? '');
  const [description, setDescription] = useState(zone?.description ?? '');
  const [latitude, setLatitude] = useState(zone?.centre === null || zone === null ? '' : String(zone.centre.latitude));
  const [longitude, setLongitude] = useState(zone?.centre === null || zone === null ? '' : String(zone.centre.longitude));
  const [radius, setRadius] = useState(zone?.radiusKm == null ? '' : String(zone.radiusKm));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const saveWords = zone === null ? 'Add zone' : 'Save changes';
  const submit = async () => {
    setBusy(true);
    setNotice(null);
    const input = { code, name, description, centreLatitude: latitude, centreLongitude: longitude, radiusKm: radius };
    const res = await attempt(zone === null ? createDeliveryZoneAction(input) : updateDeliveryZoneAction(zone.id, input, zone.version));
    setBusy(false);
    if (res.ok) onSaved({ code: code.trim().toUpperCase() });
    else setNotice({ kind: 'error', text: res.error });
  };

  return (
    <form
      className="space-y-3"
      aria-label={zone === null ? 'New delivery zone' : `Edit ${zone.code}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Message notice={notice} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${uid}-code`} label="Code" hint="Short and unique, such as WESTLANDS or KSM-CBD.">
          <input id={`${uid}-code`} value={code} onChange={(e) => setCode(e.target.value)} className={fieldClass} autoComplete="off" maxLength={20} autoFocus={autoFocus} />
        </Field>
        <Field id={`${uid}-name`} label="Name">
          <input id={`${uid}-name`} value={name} onChange={(e) => setName(e.target.value)} className={fieldClass} autoComplete="off" maxLength={80} />
        </Field>
        <div className="sm:col-span-2">
          <Field id={`${uid}-description`} label="Description (optional)">
            <input id={`${uid}-description`} value={description} onChange={(e) => setDescription(e.target.value)} className={fieldClass} autoComplete="off" maxLength={300} />
          </Field>
        </div>
      </div>
      <fieldset className="space-y-2 rounded-lg border border-line p-3">
        <legend className="px-1 text-xs font-semibold text-fg">Coverage circle (optional)</legend>
        <p className="text-[11px] text-fg-muted">A customer who drops a pin on the map inside this circle is in this zone. Leave it empty to reach this zone by the places you add to it, which is how a written address finds its zone.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field id={`${uid}-lat`} label="Centre latitude">
            <input id={`${uid}-lat`} inputMode="decimal" value={latitude} onChange={(e) => setLatitude(e.target.value)} className={`${fieldClass} font-mono`} placeholder="-1.286389" autoComplete="off" />
          </Field>
          <Field id={`${uid}-lng`} label="Centre longitude">
            <input id={`${uid}-lng`} inputMode="decimal" value={longitude} onChange={(e) => setLongitude(e.target.value)} className={`${fieldClass} font-mono`} placeholder="36.817223" autoComplete="off" />
          </Field>
          <Field id={`${uid}-radius`} label="Radius in kilometres">
            <input id={`${uid}-radius`} inputMode="decimal" value={radius} onChange={(e) => setRadius(e.target.value)} className={fieldClass} placeholder="5" autoComplete="off" />
          </Field>
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryClass} disabled={busy}>
          {busy ? 'Saving…' : saveWords}
        </button>
        <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
