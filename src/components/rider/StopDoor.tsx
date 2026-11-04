'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { deliverStopAction, failStopAction } from '@/server/domains/delivery/rider-app-actions';
import type { RiderStopView } from '@/server/domains/delivery/rider-runs';
import { Field, Message, attempt, buttonClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { FAILURE_REASONS } from '@/lib/delivery-document';
import { newTryKey, uploadProofPhoto, whereAmI } from './door-support';

type Mode = 'idle' | 'deliver' | 'fail';

/**
 * What the rider does at the door: mark the stop delivered (with the customer's code or a photo when the company asks for one) or say
 * why it could not be done. The try has its own key from the moment the form opens, so pressing again after a dropped connection is
 * the same try and never two. The photo is uploaded once and its id is kept for the retry.
 */
export function StopDoor({ runId, stop }: { runId: string; stop: RiderStopView }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('idle');
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState('');
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [receivedBy, setReceivedBy] = useState(stop.receiver.name);
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const id = useId();

  if (!stop.open) return null;

  const open = (next: Mode): void => {
    setMode(next);
    setNotice(null);
    setKey(newTryKey());
    setPhotoId(null);
  };

  const needsCode = stop.proof === 'code' || stop.proof === 'code_or_photo';
  const needsPhoto = stop.proof === 'photo' || stop.proof === 'code_or_photo';

  const send = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    let uploaded = photoId;
    if (photo !== null && uploaded === null) {
      const up = await uploadProofPhoto(photo);
      if (!up.ok) {
        setNotice({ kind: 'error', text: up.error });
        setBusy(false);
        return;
      }
      uploaded = up.photoId;
      setPhotoId(up.photoId);
    }
    const place = await whereAmI();
    const common = { runId, deliveryId: stop.deliveryId, clientKey: key, clientTime: new Date().toISOString(), note, photoId: uploaded, ...(place ?? {}) };
    const result = await attempt(mode === 'deliver' ? deliverStopAction({ ...common, receivedBy, code }) : failStopAction({ ...common, reasonCode: reason }));
    setBusy(false);
    if (!result.ok) {
      setNotice({ kind: 'error', text: result.error });
      return;
    }
    setMode('idle');
    router.refresh();
  };

  const photoLabels: Record<'photo' | 'code_or_photo' | 'other', string> = { photo: 'A photo of the goods at the door', code_or_photo: 'Or a photo of the goods at the door', other: 'A photo (optional)' };
  let photoKey: keyof typeof photoLabels = 'other';
  if (mode === 'deliver' && needsPhoto) photoKey = stop.proof === 'photo' ? 'photo' : 'code_or_photo';
  const photoLabel = photoLabels[photoKey];
  const submitWords: Record<Exclude<Mode, 'idle'>, string> = { deliver: 'Confirm delivered', fail: 'Record that it was not delivered' };

  if (mode === 'idle') {
    return (
      <div className="flex flex-wrap gap-2">
        <button type="button" className={`${primaryClass} min-h-11 flex-1`} onClick={() => open('deliver')}>
          Delivered
        </button>
        <button type="button" className={`${buttonClass} min-h-11 flex-1`} onClick={() => open('fail')}>
          Could not deliver
        </button>
      </div>
    );
  }

  return (
    <form
      aria-label={mode === 'deliver' ? 'Mark delivered' : 'Could not deliver'}
      className="space-y-3 rounded-lg border border-line bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <Message notice={notice} />
      {mode === 'deliver' ? (
        <>
          <Field id={`${id}-by`} label="Who received it">
            <input id={`${id}-by`} className={fieldClass} value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} maxLength={120} required autoComplete="off" />
          </Field>
          {needsCode ? (
            <Field id={`${id}-code`} label="The customer's code" hint="Six digits. The customer was sent it when the delivery left.">
              <input id={`${id}-code`} className={fieldClass} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={12} />
            </Field>
          ) : null}
        </>
      ) : (
        <fieldset className="space-y-1">
          <legend className="text-sm font-semibold text-fg-strong">Why was it not delivered?</legend>
          {FAILURE_REASONS.map((r) => (
            <label key={r.code} className="flex min-h-11 items-center gap-3 rounded-lg px-2 text-sm text-fg hover:bg-surface-raised">
              <input type="radio" name={`${id}-reason`} value={r.code} checked={reason === r.code} onChange={() => setReason(r.code)} className="size-5" required />
              {r.words}
            </label>
          ))}
        </fieldset>
      )}
      <Field id={`${id}-photo`} label={photoLabel}>
        <input id={`${id}-photo`} type="file" accept="image/*" capture="environment" className={fieldClass} onChange={(e) => { setPhoto(e.target.files?.[0] ?? null); setPhotoId(null); }} />
      </Field>
      <Field id={`${id}-note`} label={mode === 'fail' && reason === 'other' ? 'What happened' : 'A note (optional)'}>
        <textarea id={`${id}-note`} className={fieldClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} rows={2} required={mode === 'fail' && reason === 'other'} />
      </Field>
      <p className="text-xs text-fg-muted">Where you are is saved with this stop only if your phone allows it. It is not tracked in between.</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={`${primaryClass} min-h-11 flex-1`} disabled={busy}>
          {busy ? 'Saving…' : submitWords[mode]}
        </button>
        <button type="button" className={`${buttonClass} min-h-11`} disabled={busy} onClick={() => setMode('idle')}>
          Back
        </button>
      </div>
    </form>
  );
}
