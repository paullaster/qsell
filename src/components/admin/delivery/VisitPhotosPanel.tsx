'use client';

import { useId, useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { addVisitPhotoAction, removeVisitPhotoAction, visitPhotoLinkAction } from '@/server/domains/delivery/visit-actions';
import type { PhotoKind, PhotoView, VisitView } from '@/server/domains/delivery/visits';
import { Chip, Field, attempt, buttonClass, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { InlineConfirm } from '@/components/ui/InlineConfirm';

const KIND_WORDS: Record<PhotoKind, string> = { before: 'Before the work', after: 'After the work', other: 'Something else' };
const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });

/** Sends the picture to the photo route and gives back its id, or says in words why not. A route rather than an action: a phone's photo can be large. */
async function upload(file: File): Promise<{ ok: true; photoId: string } | { ok: false; error: string }> {
  const form = new FormData();
  form.set('file', file);
  try {
    const response = await fetch('/api/visits/photo', { method: 'POST', body: form });
    const body = (await response.json()) as { ok: boolean; data?: { photoId: string }; error?: string };
    if (body.ok && body.data !== undefined) return { ok: true, photoId: body.data.photoId };
    return { ok: false, error: body.error ?? 'The photo could not be saved. Try again.' };
  } catch {
    return { ok: false, error: 'The photo could not be sent. Check the connection and try again.' };
  }
}

/** The photos taken on a visit, to add one while the crew is on site and to look at any of them. Pictures are opened on demand by a short-lived link. */
export function VisitPhotosPanel({ visit, busy, onDone, onError }: { visit: VisitView; busy: boolean; onDone: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const open = visit.status === 'on_site' || visit.status === 'completed';
  const [kind, setKind] = useState<PhotoKind>('after');
  const [caption, setCaption] = useState('');
  const [working, setWorking] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const add = async () => {
    const chosen = file.current?.files?.[0];
    if (chosen === undefined) {
      onError('Take or choose a photo first.');
      return;
    }
    setWorking(true);
    const sent = await upload(chosen);
    if (!sent.ok) {
      setWorking(false);
      onError(sent.error);
      return;
    }
    const r = await attempt(addVisitPhotoAction({ id: visit.id, photoId: sent.photoId, kind, caption }));
    setWorking(false);
    if (!r.ok) {
      onError(r.error);
      return;
    }
    if (file.current !== null) file.current.value = '';
    setCaption('');
    onDone('The photo is kept with the visit.');
  };

  const show = async (photo: PhotoView) => {
    const r = await attempt(visitPhotoLinkAction({ id: visit.id, photoId: photo.id }));
    if (!r.ok) onError(r.error);
    else window.open(r.data.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <section aria-label={`Photos for order ${visit.orderNumber}`} className="space-y-2 rounded-lg border border-line p-3">
      <h4 className="flex items-center gap-1.5 text-sm font-bold text-fg-strong">
        <Camera className="h-3.5 w-3.5" aria-hidden="true" />
        Photos
      </h4>
      {visit.photos.length === 0 ? (
        <p className="text-xs text-fg-muted">No photo has been taken on this visit yet.</p>
      ) : (
        <ul className="divide-y divide-line text-sm" aria-label={`Photo list for order ${visit.orderNumber}`}>
          {visit.photos.map((p) => (
            <PhotoRow key={p.id} visitId={visit.id} photo={p} busy={busy || working} onShow={() => void show(p)} onDone={onDone} onError={onError} />
          ))}
        </ul>
      )}
      {open ? (
        <form
          aria-label={`Add a photo to order ${visit.orderNumber}`}
          className="grid grid-cols-1 gap-3 border-t border-line pt-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <fieldset className="flex flex-wrap gap-4 sm:col-span-2">
            <legend className="sr-only">What the photo shows</legend>
            {(['before', 'after', 'other'] as const).map((k) => (
              <label key={k} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-fg">
                <input type="radio" name={`${uid}-kind`} className="h-4 w-4 accent-indigo-600" checked={kind === k} onChange={() => setKind(k)} />
                {KIND_WORDS[k]}
              </label>
            ))}
          </fieldset>
          <Field id={`${uid}-file`} label="Take or choose a photo">
            <input id={`${uid}-file`} ref={file} type="file" accept="image/*" capture="environment" className={fieldClass} />
          </Field>
          <Field id={`${uid}-cap`} label="A few words about it (optional)">
            <input id={`${uid}-cap`} className={fieldClass} value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={200} autoComplete="off" />
          </Field>
          <div className="sm:col-span-2">
            <button type="submit" className={primaryClass} disabled={busy || working}>
              {working ? 'Saving the photo…' : 'Add the photo'}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function PhotoRow({ visitId, photo, busy, onShow, onDone, onError }: { visitId: string; photo: PhotoView; busy: boolean; onShow: () => void; onDone: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [reason, setReason] = useState('');
  return (
    <li className="space-y-1 py-2">
      <p className="flex flex-wrap items-center gap-2">
        <Chip tone={photo.kind === 'other' ? 'gray' : 'sky'}>{KIND_WORDS[photo.kind]}</Chip>
        <span className="text-xs text-fg-muted">
          {photo.by} · {when(photo.at)}
        </span>
        <button type="button" className={buttonClass} onClick={onShow}>
          Open the photo
        </button>
      </p>
      {photo.caption === null ? null : <p className="text-xs text-fg-muted">{photo.caption}</p>}
      {photo.canRemove ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field id={`${uid}-r`} label="Why it is being taken off">
            <input id={`${uid}-r`} className={fieldClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoComplete="off" />
          </Field>
          <InlineConfirm
            label={`Take off the ${KIND_WORDS[photo.kind].toLowerCase()} photo`}
            action="Take it off"
            confirm="Yes, take it off"
            busy={busy}
            onConfirm={() => {
              void (async () => {
                const r = await attempt(removeVisitPhotoAction({ id: visitId, photoId: photo.id, reason }));
                if (r.ok) onDone('The photo is taken off the visit.');
                else onError(r.error);
              })();
            }}
          />
        </div>
      ) : null}
    </li>
  );
}
