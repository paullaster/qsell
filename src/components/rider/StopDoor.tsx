'use client';

import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { deliverStopAction, failStopAction, mpesaStatusAction, promptMpesaAction } from '@/server/domains/delivery/rider-app-actions';
import type { DoorPromptStatus } from '@/server/domains/delivery/door-mpesa';
import type { RiderStopView } from '@/server/domains/delivery/rider-runs';
import { Chip, Field, Message, buttonClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { NOT_ACCEPTED_REASONS } from '@/lib/delivery-acceptance';
import { FAILURE_REASONS } from '@/lib/delivery-document';
import { putItem } from './door-queue';
import { newTryKey, uploadProofPhoto, whereAmI } from './door-support';
import { useOnline } from './useDoorQueue';

type Mode = 'idle' | 'deliver' | 'fail';

/**
 * What the rider does at the door: mark the stop delivered (with the customer's code or a photo when the company asks for one) or say
 * why it could not be done. The try has its own key from the moment the form opens, so pressing again after a dropped connection is
 * the same try and never two. The photo is uploaded once and its id is kept for the retry.
 */
export function StopDoor({ runId, riderId, stop, waiting }: { runId: string; riderId: string; stop: RiderStopView; waiting: boolean }) {
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
  const [cash, setCash] = useState('');
  const online = useOnline();
  const [payMode, setPayMode] = useState<'cash' | 'mpesa'>('cash');
  const [phone, setPhone] = useState(stop.receiver.phone ?? '');
  const [prompt, setPrompt] = useState<DoorPromptStatus | null>(null);
  const [prompting, setPrompting] = useState(false);
  const [promptNote, setPromptNote] = useState<string | null>(null);
  const [took, setTook] = useState<Record<string, { quantity: string; reason: string; note: string }>>({});
  const id = useId();

  // While a prompt is out the rider's screen asks the shop whether it was paid; the platform's word, not the customer's or the rider's.
  const promptOut = prompt?.state === 'waiting' && mode === 'deliver';
  useEffect(() => {
    if (!promptOut) return;
    const timer = setInterval(() => {
      void mpesaStatusAction({ runId, deliveryId: stop.deliveryId }).then((r) => {
        if (r.ok) setPrompt(r.data);
      });
    }, 4000);
    return () => clearInterval(timer);
  }, [promptOut, runId, stop.deliveryId]);
  const paidNow = stop.paid || prompt?.state === 'paid';
  // Opening the form on a stop where a prompt is already out (the app was reopened, or the screen reloaded) picks that up.
  const asksToPay = mode === 'deliver' && stop.collect !== null && !stop.paid && online;
  useEffect(() => {
    if (!asksToPay) return;
    let live = true;
    void mpesaStatusAction({ runId, deliveryId: stop.deliveryId }).then((r) => {
      if (live && r.ok && r.data.state !== 'none') {
        setPrompt(r.data);
        if (r.data.state === 'waiting' || r.data.state === 'paid') setPayMode('mpesa');
      }
    });
    return () => {
      live = false;
    };
  }, [asksToPay, runId, stop.deliveryId]);

  if (!stop.open) return null;
  if (waiting) return <Chip tone="amber">Saved on this phone, waiting to be sent</Chip>;

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
    // Where the rider is and the phone's time are taken now, at the door, whether or not it can be sent now.
    const place = await whereAmI();
    const payload: Record<string, unknown> = { note, clientTime: new Date().toISOString(), ...(place ?? {}) };
    if (mode === 'deliver') {
      payload.receivedBy = receivedBy;
      payload.code = code;
      if (stop.collect !== null && !paidNow) payload.cashCollected = Number(cash);
      if (part) payload.accepted = stop.items.map((i) => ({ productId: i.productId, quantity: Number(takenOf(i.productId, i.quantity).quantity), reasonCode: takenOf(i.productId, i.quantity).reason, note: takenOf(i.productId, i.quantity).note }));
    } else {
      payload.reasonCode = reason;
    }
    // Saved on this phone to be sent when there is signal. The try keeps its key, so it can never be done twice.
    const keep = async (uploaded: string | null): Promise<void> => {
      const saved = await putItem({ id: key, riderId, kind: mode === 'deliver' ? 'deliver' : 'fail', runId, deliveryId: stop.deliveryId, label: stop.number, payload, photo, photoId: uploaded, createdAt: new Date().toISOString(), state: 'waiting', message: null, tries: 0, nextAt: 0 });
      setBusy(false);
      if (saved) setMode('idle');
      else setNotice({ kind: 'error', text: 'This phone could not save it to send later. Try again when you have signal.' });
    };
    if (!navigator.onLine) {
      await keep(photoId);
      return;
    }
    let uploaded = photoId;
    if (photo !== null && uploaded === null) {
      const up = await uploadProofPhoto(photo);
      if (!up.ok) {
        if (up.network) {
          await keep(null);
          return;
        }
        setNotice({ kind: 'error', text: up.error });
        setBusy(false);
        return;
      }
      uploaded = up.photoId;
      setPhotoId(up.photoId);
    }
    let result: Awaited<ReturnType<typeof deliverStopAction>>;
    try {
      const sent = { ...payload, runId, deliveryId: stop.deliveryId, clientKey: key, photoId: uploaded };
      result = await (mode === 'deliver' ? deliverStopAction(sent) : failStopAction(sent));
    } catch {
      await keep(uploaded);
      return;
    }
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
          {stop.collect === null ? null : paidNow ? (
            <p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm font-semibold text-emerald-900">
              KSh {stop.collect} is paid. Hand over the goods; no cash is to be taken.
            </p>
          ) : (
            <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
              <p className="text-sm font-semibold">KSh {stop.collect} is to be paid at this door.</p>
              <fieldset className="flex flex-wrap gap-4">
                <legend className="sr-only">How the customer pays</legend>
                {(['cash', 'mpesa'] as const).map((m) => (
                  <label key={m} className="flex min-h-11 items-center gap-2 text-sm">
                    <input type="radio" name={`${id}-paymode`} className="size-5" checked={payMode === m} onChange={() => setPayMode(m)} />
                    {m === 'cash' ? 'Cash' : 'M-Pesa'}
                  </label>
                ))}
              </fieldset>
              {payMode === 'cash' ? (
                <Field id={`${id}-cash`} label="Cash collected (KSh)" hint="Exactly the amount above. If the customer cannot pay it all, go back and record that it could not be delivered.">
                  <input id={`${id}-cash`} className={fieldClass} inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} required autoComplete="off" />
                </Field>
              ) : (
                <div className="space-y-2">
                  <Field id={`${id}-phone`} label="The number the customer pays from" hint="An M-Pesa prompt goes to this phone. Ask the customer to enter their PIN.">
                    <input id={`${id}-phone`} className={fieldClass} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" />
                  </Field>
                  {online ? null : <p className="text-sm">There is no signal, so a prompt cannot be sent. Take cash, or wait for the signal.</p>}
                  {prompt?.state === 'waiting' ? (
                    <p role="status" className="text-sm font-semibold">
                      Waiting for the customer to enter their PIN on the phone ending {prompt.phoneEnding ?? ''}…
                    </p>
                  ) : null}
                  {prompt?.state === 'failed' && prompt.message !== null ? (
                    <p role="alert" className="text-sm font-semibold text-red-800">
                      {prompt.message}
                    </p>
                  ) : null}
                  {promptNote === null ? null : (
                    <p role="alert" className="text-sm font-semibold text-red-800">
                      {promptNote}
                    </p>
                  )}
                  <button
                    type="button"
                    className={`${buttonClass} min-h-11`}
                    disabled={!online || prompting || prompt?.state === 'waiting' || (prompt !== null && prompt.promptsLeft === 0 && prompt.state !== 'none')}
                    onClick={() => {
                      void (async () => {
                        setPrompting(true);
                        setPromptNote(null);
                        const r = await promptMpesaAction({ runId, deliveryId: stop.deliveryId, phone }).catch(() => null);
                        setPrompting(false);
                        if (r === null) setPromptNote('The prompt could not be sent. Check your signal and try again.');
                        else if (r.ok) setPrompt(r.data);
                        else setPromptNote(r.error);
                      })();
                    }}
                  >
                    {prompting ? 'Sending…' : prompt === null || prompt.state === 'none' ? 'Send the M-Pesa prompt' : 'Send another prompt'}
                  </button>
                </div>
              )}
            </div>
          )}
          {stop.collect !== null ? null : <label className="flex min-h-11 items-center gap-3 text-sm text-fg">
            <input type="checkbox" className="size-5" checked={part} onChange={(e) => setPart(e.target.checked)} />
            The customer took only part of it
          </label>}
          {part && stop.collect === null ? (
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
        <button type="submit" className={`${primaryClass} min-h-11 flex-1`} disabled={busy || (mode === 'deliver' && stop.collect !== null && !paidNow && payMode === 'mpesa')}>
          {busy ? 'Saving…' : submitWords[mode]}
        </button>
        <button type="button" className={`${buttonClass} min-h-11`} disabled={busy} onClick={() => setMode('idle')}>
          Back
        </button>
      </div>
    </form>
  );
}
