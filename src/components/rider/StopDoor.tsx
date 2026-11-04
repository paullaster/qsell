'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { deliverStopAction, failStopAction } from '@/server/domains/delivery/rider-app-actions';
import type { RiderStopView } from '@/server/domains/delivery/rider-runs';
import { Field, Message, attempt, buttonClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { NOT_ACCEPTED_REASONS } from '@/lib/delivery-acceptance';
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
  const [part, setPart] = useState(false);
  const [took, setTook] = useState<Record<string, { quantity: string; reason: string; note: string }>>({});
  const id = useId();

  if (!stop.open) return null;

  const open = (next: Mode): void => {
    setMode(next);
    setNotice(null);
    setKey(newTryKey());
    setPhotoId(null);
    setPart(false);
    setTook({});
  };

  const takenOf = (productId: string, carried: number): { quantity: string; reason: string; note: string } => took[productId] ?? { quantity: String(carried), reason: '', note: '' };
  const change = (productId: string, carried: number, patch: Partial<{ quantity: string; reason: string; note: string }>): void => setTook({ ...took, [productId]: { ...takenOf(productId, carried), ...patch } });

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
    const result = await attempt(mode === 'deliver' ? deliverStopAction({ ...common, receivedBy, code, ...(part ? { accepted: stop.items.map((i) => ({ productId: i.productId, quantity: Number(takenOf(i.productId, i.quantity).quantity), reasonCode: takenOf(i.productId, i.quantity).reason, note: takenOf(i.productId, i.quantity).note })) } : {}) }) : failStopAction({ ...common, reasonCode: reason }));
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
          <label className="flex min-h-11 items-center gap-3 text-sm text-fg">
            <input type="checkbox" className="size-5" checked={part} onChange={(e) => setPart(e.target.checked)} />
            The customer took only part of it
          </label>
          {part ? (
            <ul className="space-y-3" aria-label="What the customer took">
              {stop.items.map((i) => {
                const t = takenOf(i.productId, i.quantity);
                const short = Number(t.quantity) < i.quantity;
                return (
                  <li key={i.productId} className="space-y-2 rounded-lg border border-line p-2">
                    <Field id={`${id}-q-${i.productId}`} label={`${i.name}: how many did they take (of ${String(i.quantity)})?`}>
                      <input id={`${id}-q-${i.productId}`} className={fieldClass} inputMode="decimal" value={t.quantity} onChange={(e) => change(i.productId, i.quantity, { quantity: e.target.value })} autoComplete="off" />
                    </Field>
                    {short ? (
                      <fieldset className="space-y-1">
                        <legend className="text-xs font-semibold text-fg-muted">Why was the rest not taken?</legend>
                        {NOT_ACCEPTED_REASONS.map((r) => (
                          <label key={r.code} className="flex min-h-11 items-center gap-3 text-sm text-fg">
                            <input type="radio" name={`${id}-nr-${i.productId}`} className="size-5" checked={t.reason === r.code} onChange={() => change(i.productId, i.quantity, { reason: r.code })} />
                            {r.words}
                          </label>
                        ))}
                        {t.reason === 'other' ? (
                          <input aria-label={`What happened to the ${i.name} that was not taken`} className={fieldClass} value={t.note} onChange={(e) => change(i.productId, i.quantity, { note: e.target.value })} maxLength={300} />
                        ) : null}
                      </fieldset>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
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
