'use client';

import { use, useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { deliveryAction, deliveryStepAction, proofPhotoLinkAction } from '@/server/domains/delivery/document-actions';
import { deliveryCostsAction, recordCourierChargeAction } from '@/server/domains/delivery/cost-actions';
import type { CostView } from '@/server/domains/delivery/costs';
import { markDoorPaymentAction, unmarkDoorPaymentAction } from '@/server/domains/delivery/door-payment-actions';
import { courierNewsAction, deliveryExtrasAction } from '@/server/domains/delivery/run-actions';
import type { DeliveryView } from '@/server/domains/delivery/documents';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { METHOD_WORDS } from '@/lib/delivery-methods';
import type { DeliveryAction, DeliveryStatus } from '@/lib/delivery-document';
import type { Choice } from '@/lib/payment-options';
import { KIND_WORDS, isMessageKind } from '@/lib/delivery-messages';

type Loaded = Awaited<ReturnType<typeof deliveryAction>>;

const TONE: Record<DeliveryStatus, 'green' | 'amber' | 'red' | 'sky' | 'gray'> = {
  draft: 'gray',
  released: 'sky',
  picking: 'sky',
  packed: 'sky',
  ready: 'amber',
  out_for_delivery: 'amber',
  delivered: 'green',
  failed_attempt: 'red',
  returned: 'red',
  cancelled: 'gray',
};

const DONE: Record<DeliveryAction, string> = {
  release: 'Released for picking.',
  start_picking: 'Picking started.',
  record_picked: 'What was picked is recorded.',
  mark_packed: 'Marked packed.',
  mark_ready: 'Marked ready to go.',
  dispatch: 'Sent out.',
  deliver: 'Marked delivered.',
  fail_attempt: 'The failed attempt is recorded.',
  reattempt: 'Ready to try again.',
  return: 'Returned. What it carried is open on the order again.',
  cancel: 'Cancelled. What it carried is open on the order again.',
};

const MESSAGE_TONE = { sent: 'green', failed: 'red', skipped: 'gray', queued: 'gray' } as const;
const MESSAGE_WORDS = { sent: 'Sent', failed: 'Not sent yet', skipped: 'Not sent', queued: 'Waiting to send' } as const;
const ATTEMPT_TONE = (result: string): 'green' | 'amber' | 'red' => {
  if (result === 'delivered') return 'green';
  return result === 'part_accepted' ? 'amber' : 'red';
};
const ATTEMPT_CHIP = (result: string): string => {
  if (result === 'delivered') return 'Delivered';
  return result === 'part_accepted' ? 'Part accepted' : 'Not delivered';
};
const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });
const qty = (n: number): string => String(n);

type Extras = Extract<Awaited<ReturnType<typeof deliveryExtrasAction>>, { ok: true }>['data'];

export function DeliveryDetailClient({ viewPromise, canFulfil, extras }: { viewPromise: ReturnType<typeof deliveryAction>; canFulfil: Promise<boolean>; extras: ReturnType<typeof deliveryExtrasAction> }) {
  const res: Loaded = use(viewPromise);
  const allowed = use(canFulfil);
  const more = use(extras);
  return res.ok ? <DeliveryScreen initial={res.data} canFulfil={allowed} initialExtras={more.ok ? more.data : { shipment: null, run: null, canDispatch: false, messages: [], canAllowDoor: false, canCosts: false }} /> : <LoadFailed error={res.error} />;
}

function whereTo(view: DeliveryView): string {
  const a = view.destination.address;
  const words = a === null ? '' : [a.area, a.town, a.county].filter((p): p is string => p !== null && p !== '').join(', ');
  const pin = view.destination.pin === null ? '' : `Pin ${String(view.destination.pin.latitude)}, ${String(view.destination.pin.longitude)}`;
  return [words, pin].filter((p) => p !== '').join(' · ');
}

function DeliveryScreen({ initial, canFulfil, initialExtras }: { initial: DeliveryView; canFulfil: boolean; initialExtras: Extras }) {
  const uid = useId();
  const [view, setView] = useState(initial);
  const [extra, setExtra] = useState(initialExtras);
  const [news, setNews] = useState<{ state: Choice | null; note: string; receivedBy: string; tracking: string }>({ state: null, note: '', receivedBy: '', tracking: '' });
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [receivedBy, setReceivedBy] = useState('');
  const [retryDay, setRetryDay] = useState('');
  const [courierName, setCourierName] = useState(initial.courierName ?? '');
  const [tracking, setTracking] = useState(initial.trackingNumber ?? '');
  const [failure, setFailure] = useState<Choice | null>(null);
  const [recipientName, setRecipientName] = useState(initial.recipientName ?? '');
  const [recipientPhone, setRecipientPhone] = useState(initial.recipientPhone ?? '');
  const [notes, setNotes] = useState(initial.notes ?? '');
  const [back, setBack] = useState<Record<string, { quantity: string; disposition: Choice | null }>>({});
  const [fix, setFix] = useState<Record<string, { quantity: string; disposition: Choice | null; reason: string }>>({});

  const run = async (step: DeliveryAction | 'amend' | 'receive_return' | 'correct_return', extra: Record<string, unknown>, done: string, after?: () => void) => {
    setBusy(true);
    setNotice(null);
    const result = await attempt(deliveryStepAction({ deliveryId: view.id, step, expectedVersion: view.version, ...extra }));
    setBusy(false);
    if (!result.ok) {
      setNotice({ kind: 'error', text: result.error });
      return;
    }
    setView(result.data);
    // A step can make or change the courier's shipment or take the delivery off a run, so these are read again.
    const again = await deliveryExtrasAction(view.id);
    if (again.ok) setExtra(again.data);
    setNotice({ kind: 'ok', text: done });
    after?.();
  };

  const can = (action: DeliveryAction): boolean => canFulfil && view.actions.some((a) => a.action === action);
  const picking = can('record_picked');
  const pickedFor = (line: DeliveryView['lines'][number]): string => picked[line.productId] ?? String(line.picked ?? line.quantity);
  const editable = canFulfil && view.status !== 'out_for_delivery' && view.status !== 'delivered' && view.status !== 'returned' && view.status !== 'cancelled';
  const simple: DeliveryAction[] = ['release', 'start_picking', 'mark_packed', 'mark_ready'];

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title={`Delivery ${view.number}`}
        intro={
          <>
            For order <span className="font-mono">{view.orderNumber}</span> · {view.customerName} · {METHOD_WORDS[view.method].name} from {view.branch.name}
          </>
        }
        actions={<Chip tone={TONE[view.status]}>{view.statusWords}</Chip>}
      />
      <Link href="/admin/delivery/deliveries" className="inline-flex min-h-10 items-center text-xs font-semibold text-indigo-500 underline">
        ← All deliveries
      </Link>
      {view.status === 'draft' || view.status === 'cancelled' ? null : (
        <p className="flex flex-wrap gap-4 text-xs font-semibold">
          <a href={`/api/admin/delivery/deliveries/${view.id}/note?inline=1`} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center text-indigo-500 underline">
            Print the delivery note
          </a>
          <a href={`/api/admin/delivery/deliveries/${view.id}/note`} className="inline-flex min-h-10 items-center text-indigo-500 underline">
            Download the delivery note (PDF)
          </a>
        </p>
      )}
      <Message notice={notice} />

      <section aria-label="Where it goes" className={`${cardClass} space-y-2`}>
        <h2 className="text-sm font-bold text-fg-strong">Where it goes</h2>
        <p className="text-sm text-fg">{whereTo(view) === '' ? 'No place was recorded for this delivery.' : whereTo(view)}</p>
        <p className="text-sm text-fg-muted">
          {view.recipientName === null ? 'To the person who ordered it' : `To ${view.recipientName}${view.recipientPhone === null ? '' : `, ${view.recipientPhone}`}`}
          {view.notes === null ? '' : ` · ${view.notes}`}
        </p>
        {view.courierName === null ? null : (
          <p className="text-sm text-fg-muted">
            With {view.courierName}
            {view.trackingNumber === null ? '' : `, tracking number ${view.trackingNumber}`}
          </p>
        )}
        {view.receivedBy === null ? null : <p className="text-sm text-fg-muted">Received by {view.receivedBy}{view.deliveredAt === null ? '' : ` on ${when(view.deliveredAt)}`}</p>}
        {editable ? (
          <details className="text-sm">
            <summary className="min-h-10 cursor-pointer py-2 font-semibold text-indigo-500">Change who receives it, or the note</summary>
            <form
              className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run('amend', { recipientName, recipientPhone, notes }, 'The details are changed.');
              }}
            >
              <Field id={`${uid}-rn`} label="Who receives it">
                <input id={`${uid}-rn`} value={recipientName} onChange={(e) => setRecipientName(e.target.value)} maxLength={120} className={fieldClass} autoComplete="off" />
              </Field>
              <Field id={`${uid}-rp`} label="Their phone">
                <input id={`${uid}-rp`} type="tel" value={recipientPhone} onChange={(e) => setRecipientPhone(e.target.value)} maxLength={40} className={`${fieldClass} font-mono`} autoComplete="off" />
              </Field>
              <div className="sm:col-span-2">
                <Field id={`${uid}-nt`} label="Note for the rider">
                  <input id={`${uid}-nt`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} className={fieldClass} autoComplete="off" />
                </Field>
              </div>
              <div className="sm:col-span-2">
                <button type="submit" className={buttonClass} disabled={busy}>
                  Save these details
                </button>
              </div>
            </form>
          </details>
        ) : null}
      </section>

      {extra.run === null ? null : (
        <p className="text-sm text-fg-muted">
          On run{' '}
          <Link href={`/admin/delivery/runs/${extra.run.id}`} className="font-mono font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
            {extra.run.number}
          </Link>{' '}
          with {extra.run.riderName}.
        </p>
      )}
      {extra.shipment === null ? null : (
        <section aria-label="Courier" className={`${cardClass} space-y-3`}>
          <h2 className="text-sm font-bold text-fg-strong">With the courier</h2>
          <p className="text-sm text-fg">
            {extra.shipment.courierName}
            {extra.shipment.trackingNumber === null ? '' : ` · tracking number ${extra.shipment.trackingNumber}`} · <Chip tone={extra.shipment.status === 'exception' ? 'red' : 'sky'}>{extra.shipment.statusWords}</Chip>
          </p>
          {extra.shipment.lastNote === null ? null : <p className="text-xs text-fg-muted">{extra.shipment.lastNote}</p>}
          {extra.canDispatch && view.status === 'out_for_delivery' ? (
            <details className="text-sm">
              <summary className="min-h-10 cursor-pointer py-2 font-semibold text-indigo-500">Record what the courier reported</summary>
              <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2">
                <ChoicePicker label="What the courier reported" source="courier-news" choice={news.state} onChoice={(c) => setNews({ ...news, state: c })} placeholder="Choose" clearable />
                <Field id={`${uid}-cn-note`} label="Note">
                  <input id={`${uid}-cn-note`} value={news.note} onChange={(e) => setNews({ ...news, note: e.target.value })} maxLength={300} className={fieldClass} autoComplete="off" />
                </Field>
                {news.state?.id === 'delivered' ? (
                  <Field id={`${uid}-cn-by`} label="Who received it">
                    <input id={`${uid}-cn-by`} value={news.receivedBy} onChange={(e) => setNews({ ...news, receivedBy: e.target.value })} maxLength={120} className={fieldClass} autoComplete="off" />
                  </Field>
                ) : null}
                <Field id={`${uid}-cn-tr`} label="Tracking number (if it changed)">
                  <input id={`${uid}-cn-tr`} value={news.tracking} onChange={(e) => setNews({ ...news, tracking: e.target.value })} maxLength={120} className={`${fieldClass} font-mono`} autoComplete="off" />
                </Field>
                <div className="sm:col-span-2">
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy || news.state === null}
                    onClick={() =>
                      void (async () => {
                        setBusy(true);
                        setNotice(null);
                        const r = await attempt(courierNewsAction({ deliveryId: view.id, state: news.state?.id, note: news.note, receivedBy: news.receivedBy, trackingNumber: news.tracking }));
                        if (!r.ok) {
                          setBusy(false);
                          setNotice({ kind: 'error', text: r.error });
                          return;
                        }
                        setView(r.data);
                        const again = await deliveryExtrasAction(view.id);
                        if (again.ok) setExtra(again.data);
                        setBusy(false);
                        setNews({ state: null, note: '', receivedBy: '', tracking: '' });
                        setNotice({ kind: 'ok', text: 'The courier’s news is recorded.' });
                      })()
                    }
                  >
                    Record the news
                  </button>
                </div>
              </div>
            </details>
          ) : null}
        </section>
      )}

      <section aria-label="What it carries" className={`${cardClass} space-y-3`}>
        <h2 className="text-sm font-bold text-fg-strong">What it carries</h2>
        <ul className="divide-y divide-line">
          {view.lines.map((line) => (
            <li key={line.id} className="grid grid-cols-1 gap-2 py-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center sm:gap-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-fg-strong">{line.productName}</p>
                <p className="font-mono text-xs text-fg-muted">{line.sku}</p>
                {line.issued > 0 ? <p className="text-xs text-fg-muted">Left the shelf: {qty(line.issued)}</p> : null}
              </div>
              <p className="text-sm text-fg">
                <span className="text-xs text-fg-muted">Planned </span>
                {qty(line.quantity)}
              </p>
              {picking ? (
                <div>
                  <label htmlFor={`${uid}-p-${line.id}`} className="block text-xs text-fg-muted">
                    Picked: {line.productName}
                  </label>
                  <input
                    id={`${uid}-p-${line.id}`}
                    inputMode="decimal"
                    value={pickedFor(line)}
                    onChange={(e) => setPicked({ ...picked, [line.productId]: e.target.value })}
                    className={`${fieldClass} w-28 font-mono`}
                    autoComplete="off"
                  />
                </div>
              ) : (
                <p className="text-sm text-fg">
                  <span className="text-xs text-fg-muted">Picked </span>
                  {line.picked === null ? '—' : qty(line.picked)}
                </p>
              )}
              <p className="text-sm text-fg">
                <span className="text-xs text-fg-muted">Delivered </span>
                {qty(line.delivered)}
              </p>
            </li>
          ))}
        </ul>
        {picking ? (
          <div className="space-y-2">
            <p className="text-xs text-fg-muted">If less was picked than planned, the difference stays open on the order, to go on another delivery or be cancelled.</p>
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => void run('record_picked', { picked: view.lines.map((l) => ({ productId: l.productId, quantity: Number(pickedFor(l)) })) }, DONE.record_picked)}
            >
              Record what was picked
            </button>
          </div>
        ) : null}
      </section>

      {extra.canCosts ? <CostsPanel view={view} onError={(text) => setNotice({ kind: 'error', text })} /> : null}
      <DoorPanel view={view} canAllow={extra.canAllowDoor} onChanged={(next, text) => { setView(next); setNotice({ kind: 'ok', text }); }} onError={(text) => setNotice({ kind: 'error', text })} />

      {canFulfil && view.actions.length > 0 ? (
        <section aria-label="Next steps" className={`${cardClass} space-y-4`}>
          <h2 className="text-sm font-bold text-fg-strong">Next</h2>
          <div className="flex flex-wrap gap-2">
            {simple
              .filter((a) => can(a))
              .map((a) => (
                <button key={a} type="button" className={primaryClass} disabled={busy} onClick={() => void run(a, {}, DONE[a])}>
                  {view.actions.find((x) => x.action === a)?.words}
                </button>
              ))}
          </div>

          {can('dispatch') ? (
            <div className="space-y-3 rounded-lg border border-line bg-surface p-3">
              {view.method === 'courier' ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field id={`${uid}-cn`} label="Which courier has it">
                    <input id={`${uid}-cn`} value={courierName} onChange={(e) => setCourierName(e.target.value)} maxLength={120} className={fieldClass} autoComplete="off" />
                  </Field>
                  <Field id={`${uid}-tn`} label="Courier’s tracking number (if given)">
                    <input id={`${uid}-tn`} value={tracking} onChange={(e) => setTracking(e.target.value)} maxLength={120} className={`${fieldClass} font-mono`} autoComplete="off" />
                  </Field>
                </div>
              ) : null}
              <button type="button" className={primaryClass} disabled={busy} onClick={() => void run('dispatch', { courierName, trackingNumber: tracking }, DONE.dispatch)}>
                Send out
              </button>
            </div>
          ) : null}

          {can('deliver') || can('fail_attempt') ? (
            <div className="space-y-3 rounded-lg border border-line bg-surface p-3">
              <h3 className="text-xs font-bold tracking-wider text-fg-muted uppercase">At the door</h3>
              {can('deliver') ? (
                <div className="space-y-2">
                  <Field id={`${uid}-rb`} label="Who received it">
                    <input id={`${uid}-rb`} value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} maxLength={120} className={fieldClass} autoComplete="off" />
                  </Field>
                  <button type="button" className={primaryClass} disabled={busy} onClick={() => void run('deliver', { receivedBy }, DONE.deliver, () => setReceivedBy(''))}>
                    Mark delivered
                  </button>
                </div>
              ) : null}
              {can('fail_attempt') ? (
                <div className="space-y-2">
                  <ChoicePicker label="Why it did not happen" source="delivery-failure-reasons" choice={failure} onChoice={setFailure} placeholder="Choose why" clearable />
                  <Field id={`${uid}-fn`} label="What happened (needed if the reason is “another reason”)">
                    <input id={`${uid}-fn`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className={fieldClass} autoComplete="off" />
                  </Field>
                  <button type="button" className={buttonClass} disabled={busy || failure === null} onClick={() => void run('fail_attempt', { reasonCode: failure?.id, note }, DONE.fail_attempt, () => { setFailure(null); setNote(''); })}>
                    Record a failed attempt
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {can('reattempt') || can('return') ? (
            <div className="space-y-3 rounded-lg border border-line bg-surface p-3">
              <h3 className="text-xs font-bold tracking-wider text-fg-muted uppercase">After a failed attempt ({view.failedAttempts} so far)</h3>
              {view.scheduledFor === null ? null : <p className="text-sm text-fg">Wanted again on <strong>{view.scheduledFor}</strong>.</p>}
              {can('reattempt') ? (
                <div className="space-y-2">
                  <Field id={`${uid}-rd`} label="Day it is wanted (optional)" hint="After today and within two weeks, for example the day the customer asked for.">
                    <input id={`${uid}-rd`} type="date" value={retryDay} onChange={(e) => setRetryDay(e.target.value)} className={fieldClass} />
                  </Field>
                  <button type="button" className={primaryClass} disabled={busy} onClick={() => void run('reattempt', { day: retryDay }, DONE.reattempt, () => setRetryDay(''))}>
                    Try again
                  </button>
                </div>
              ) : null}
              {can('return') ? (
                <div className="space-y-2">
                  <Field id={`${uid}-rt`} label="Why it is being returned">
                    <input id={`${uid}-rt`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className={fieldClass} autoComplete="off" />
                  </Field>
                  <InlineConfirm label="Return this delivery" action="Return it" confirm="Yes, return it" busy={busy} onConfirm={() => void run('return', { reason }, DONE.return, () => setReason(''))} />
                </div>
              ) : null}
            </div>
          ) : null}

          {can('cancel') ? (
            <div className="space-y-2 rounded-lg border border-line bg-surface p-3">
              <h3 className="text-xs font-bold tracking-wider text-fg-muted uppercase">Not going ahead</h3>
              <Field id={`${uid}-cr`} label="Why it is being cancelled">
                <input id={`${uid}-cr`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className={fieldClass} autoComplete="off" />
              </Field>
              <InlineConfirm label="Cancel this delivery" action="Cancel the delivery" confirm="Yes, cancel it" busy={busy} onConfirm={() => void run('cancel', { reason }, DONE.cancel, () => setReason(''))} />
            </div>
          ) : null}
        </section>
      ) : null}

      {view.status === 'returned' || view.lines.some((l) => l.back !== null) ? (
        <section aria-label="Goods that came back" className={`${cardClass} space-y-3`}>
          <h2 className="text-sm font-bold text-fg-strong">Goods that came back</h2>
          <ul className="divide-y divide-line">
            {view.lines.map((line) => {
              const open = line.back?.receipt === null && line.back.choices.length > 0;
              const entry = back[line.productId] ?? { quantity: String(line.back?.could ?? 0), disposition: null };
              return (
                <li key={line.id} className="space-y-2 py-3">
                  <p className="text-sm font-semibold text-fg-strong">{line.productName}</p>
                  {line.back?.receipt ? (
                    <div className="space-y-2">
                      <p className="text-sm text-fg">
                        Received {qty(line.back.receipt.quantity)}: {line.back.receipt.words} <span className="text-xs text-fg-muted">on {when(line.back.receipt.receivedAt)}</span>
                        {line.back.receipt.correctionReason === null ? null : <span className="text-xs text-fg-muted"> · corrected (revision {line.back.receipt.revision}): {line.back.receipt.correctionReason}</span>}
                      </p>
                      {line.back.earlier.map((e) => (
                        <p key={e.revision} className="text-xs text-fg-muted">
                          Before: {qty(e.quantity)}, {e.words} (revision {e.revision})
                        </p>
                      ))}
                      {canFulfil && line.back.receipt.correctable ? (
                        <details className="text-sm">
                          <summary className="min-h-10 cursor-pointer py-2 font-semibold text-indigo-500">Correct this receipt</summary>
                          <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-[8rem_1fr]">
                            <Field id={`${uid}-fq-${line.id}`} label={`Corrected quantity: ${line.productName}`}>
                              <input id={`${uid}-fq-${line.id}`} inputMode="decimal" value={fix[line.productId]?.quantity ?? String(line.back.receipt.quantity)} onChange={(e) => setFix({ ...fix, [line.productId]: { quantity: e.target.value, disposition: fix[line.productId]?.disposition ?? null, reason: fix[line.productId]?.reason ?? '' } })} className={`${fieldClass} font-mono`} autoComplete="off" />
                            </Field>
                            <ChoicePicker label={`Corrected choice: ${line.productName}`} source="delivery-return-dispositions" choice={fix[line.productId]?.disposition ?? null} onChoice={(c) => setFix({ ...fix, [line.productId]: { quantity: fix[line.productId]?.quantity ?? String(line.back?.receipt?.quantity ?? 0), disposition: c, reason: fix[line.productId]?.reason ?? '' } })} placeholder="Choose" clearable />
                            <div className="sm:col-span-2">
                              <Field id={`${uid}-fr-${line.id}`} label="Why it is being corrected">
                                <input id={`${uid}-fr-${line.id}`} value={fix[line.productId]?.reason ?? ''} onChange={(e) => setFix({ ...fix, [line.productId]: { quantity: fix[line.productId]?.quantity ?? String(line.back?.receipt?.quantity ?? 0), disposition: fix[line.productId]?.disposition ?? null, reason: e.target.value } })} maxLength={300} className={fieldClass} autoComplete="off" />
                              </Field>
                            </div>
                            <div className="sm:col-span-2">
                              <button
                                type="button"
                                className={buttonClass}
                                disabled={busy}
                                onClick={() => {
                                  const f = fix[line.productId];
                                  void run('correct_return', { productId: line.productId, quantity: Number(f?.quantity ?? line.back?.receipt?.quantity ?? 0), disposition: f?.disposition?.id ?? '', reason: f?.reason ?? '' }, 'The receipt is corrected.', () => setFix({}));
                                }}
                              >
                                Correct the receipt
                              </button>
                            </div>
                          </div>
                        </details>
                      ) : null}
                      {line.back.receipt.correctable ? null : <p className="text-xs text-fg-muted">These goods have gone out again, so the receipt can no longer be corrected. A stock adjustment puts right any difference.</p>}
                    </div>
                  ) : (
                    <p className="text-xs text-fg-muted">Up to {qty(line.back?.could ?? 0)} could have come back. It can be: {line.back?.choices.map((c) => c.name).join(', ')}.</p>
                  )}
                  {open && canFulfil ? (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_1fr]">
                      <Field id={`${uid}-bq-${line.id}`} label={`How many came back: ${line.productName}`}>
                        <input id={`${uid}-bq-${line.id}`} inputMode="decimal" value={entry.quantity} onChange={(e) => setBack({ ...back, [line.productId]: { ...entry, quantity: e.target.value } })} className={`${fieldClass} font-mono`} autoComplete="off" />
                      </Field>
                      <ChoicePicker label={`What to do with it: ${line.productName}`} source="delivery-return-dispositions" choice={entry.disposition} onChoice={(c) => setBack({ ...back, [line.productId]: { ...entry, disposition: c } })} placeholder="Choose" clearable />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {canFulfil && view.lines.some((l) => l.back?.receipt === null && l.back.choices.length > 0) ? (
            <button
              type="button"
              className={primaryClass}
              disabled={busy}
              onClick={() => {
                const lines = view.lines
                  .filter((l) => l.back?.receipt === null && l.back.choices.length > 0)
                  .map((l) => ({ productId: l.productId, quantity: Number(back[l.productId]?.quantity ?? l.back?.could ?? 0), disposition: back[l.productId]?.disposition?.id ?? '' }));
                void run('receive_return', { lines }, 'The returned goods are received.', () => setBack({}));
              }}
            >
              Receive these goods
            </button>
          ) : null}
        </section>
      ) : null}

      {view.attempts.length === 0 ? null : (
        <section aria-label="At the door" className={`${cardClass} space-y-3`}>
          <h2 className="text-sm font-bold text-fg-strong">At the door</h2>
          <ol className="space-y-3">
            {view.attempts.map((a) => (
              <li key={a.attemptNo} className="space-y-1 text-sm">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-semibold text-fg-strong">
                    Try {a.attemptNo}: {a.resultWords}
                  </span>
                  <Chip tone={ATTEMPT_TONE(a.result)}>{ATTEMPT_CHIP(a.result)}</Chip>
                  <time dateTime={a.occurredAt} className="text-xs text-fg-muted">
                    {when(a.occurredAt)}
                  </time>
                  <span className="text-xs text-fg-muted">by {a.riderName}</span>
                </div>
                {a.receivedBy === null ? null : <p className="text-fg">Received by {a.receivedBy}.</p>}
                {a.taken.length === 0 ? null : (
                  <ul className="text-fg" aria-label="What the customer took">
                    {a.taken.map((t) => (
                      <li key={t.productName}>
                        {t.productName}: took {qty(t.accepted)} of {qty(t.carried)}
                        {t.reasonWords === null ? '' : ` (${t.reasonWords}${t.note === null ? '' : `: ${t.note}`})`}
                      </li>
                    ))}
                  </ul>
                )}
                {a.note === null ? null : <p className="text-fg">{a.note}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  {a.proofs.map((p) =>
                    p.kind === 'code' ? (
                      <Chip key={p.id} tone="sky">
                        Customer&apos;s code matched
                      </Chip>
                    ) : (
                      <button
                        key={p.id}
                        type="button"
                        className={buttonClass}
                        onClick={async () => {
                          setNotice(null);
                          const r = await attempt(proofPhotoLinkAction(p.id));
                          if (!r.ok) setNotice({ kind: 'error', text: r.error });
                          else window.open(r.data.url, '_blank', 'noopener,noreferrer');
                        }}
                      >
                        Open the photo
                      </button>
                    ),
                  )}
                  {a.place === null ? null : (
                    <a className="text-xs font-medium text-brand underline" href={`https://www.openstreetmap.org/?mlat=${String(a.place.lat)}&mlon=${String(a.place.lng)}#map=18/${String(a.place.lat)}/${String(a.place.lng)}`} target="_blank" rel="noopener noreferrer">
                      Where the rider was
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {extra.messages.length === 0 ? null : (
        <section aria-label="Messages to the customer" className={`${cardClass} space-y-3`}>
          <h2 className="text-sm font-bold text-fg-strong">Messages to the customer</h2>
          <ul className="space-y-1.5">
            {extra.messages.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-semibold text-fg-strong">{isMessageKind(m.kind) ? KIND_WORDS[m.kind] : m.kind}</span>
                <Chip tone={MESSAGE_TONE[m.status]}>{MESSAGE_WORDS[m.status]}</Chip>
                <span className="text-xs text-fg-muted">
                  {m.recipient === '' ? '' : `to ${m.recipient} · `}
                  {when(m.sentAt ?? m.createdAt)}
                </span>
                {m.note === null ? null : <span className="text-xs text-fg-muted">{m.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="History" className={`${cardClass} space-y-3`}>
        <h2 className="text-sm font-bold text-fg-strong">History</h2>
        <ol className="space-y-2">
          {view.events.map((e) => (
            <li key={e.sequence} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
              <time dateTime={e.occurredAt} className="text-xs text-fg-muted">
                {when(e.occurredAt)}
              </time>
              <span className="font-semibold text-fg-strong">{e.actionWords}</span>
              {e.toStatus === null ? null : <span className="text-xs text-fg-muted">→ {e.toStatus.replace(/_/g, ' ')}</span>}
              {e.note === null ? null : <span className="text-fg">{e.note}</span>}
              {e.actorId === null ? null : <span className="text-xs text-fg-muted">by {e.actorId}</span>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/** Letting a delivery of an unpaid order go out to be paid in cash at the door, and taking that back before it goes. */
function DoorPanel({ view, canAllow, onChanged, onError }: { view: DeliveryView; canAllow: boolean; onChanged: (next: DeliveryView, text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const before = ['draft', 'released', 'picking', 'packed', 'ready'].includes(view.status);
  if (view.door === null && !(canAllow && before && view.method === 'own_fleet')) return null;
  const change = async (kind: 'mark' | 'unmark'): Promise<void> => {
    setBusy(true);
    const r = kind === 'mark' ? await attempt(markDoorPaymentAction({ deliveryId: view.id, reason })) : await attempt(unmarkDoorPaymentAction({ deliveryId: view.id, reason }));
    if (!r.ok) {
      setBusy(false);
      onError(r.error);
      return;
    }
    const again = await attempt(deliveryAction(view.id));
    setBusy(false);
    setReason('');
    if (again.ok) onChanged(again.data, kind === 'mark' ? 'This delivery will be paid in cash at the door.' : 'This delivery is no longer to be paid at the door.');
  };
  return (
    <section aria-label="Paid at the door" className={`${cardClass} space-y-3`}>
      <h2 className="text-sm font-bold text-fg-strong">Paid at the door</h2>
      {view.door === null ? (
        <p className="text-sm text-fg-muted">Not marked. If the customer will pay in cash when it arrives, mark it here before it goes out. The whole order must be on this delivery.</p>
      ) : (
        <p className="text-sm text-fg">
          The rider will collect <strong>KSh {view.door.amount}</strong> in cash.
          {view.door.reason === null ? '' : ` Allowed because: ${view.door.reason}.`}
        </p>
      )}
      {canAllow && before ? (
        <div className="space-y-2">
          <Field id={`${uid}-dr`} label={view.door === null ? 'Why it may be paid at the door' : 'Why it is no longer to be paid at the door'}>
            <input id={`${uid}-dr`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className={fieldClass} autoComplete="off" />
          </Field>
          <button type="button" className={view.door === null ? primaryClass : buttonClass} disabled={busy} onClick={() => void change(view.door === null ? 'mark' : 'unmark')}>
            {view.door === null ? 'Mark to be paid at the door' : 'Take that back'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** What this delivery cost: rider pay earned for it, and what a courier charged (typed in here for a delivery sent with a courier). */
function CostsPanel({ view, onError }: { view: DeliveryView; onError: (text: string) => void }) {
  const uid = useId();
  const [costs, setCosts] = useState<CostView[] | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = (): void => {
    void attempt(deliveryCostsAction(view.id)).then((r) => {
      if (r.ok) setCosts(r.data);
      else onError(r.error);
    });
  };
  useEffect(reload, [view.id, view.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = (costs ?? []).reduce((n, c) => n + Math.round(Number(c.amount) * 100), 0) / 100;
  const courierOut = view.method === 'courier' && view.status !== 'draft' && view.courierName !== null;
  if (costs !== null && costs.length === 0 && !courierOut) return null;
  return (
    <section aria-label="What it cost" className={`${cardClass} space-y-3`}>
      <h2 className="text-sm font-bold text-fg-strong">What it cost</h2>
      {costs === null ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading…
        </p>
      ) : (
        <ul className="space-y-1 text-sm" aria-label="Costs of this delivery">
          {costs.map((c) => (
            <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                {c.kindWords}
                {c.riderName === null ? '' : ` · ${c.riderName}`}
                {c.courierName === null ? '' : ` · ${c.courierName}`}
                {c.note === null ? '' : ` · ${c.note}`}
              </span>
              <span className="font-mono">
                {c.currency} {c.amount}
              </span>
            </li>
          ))}
          {costs.length === 0 ? <li className="text-fg-muted">Nothing yet.</li> : <li className="flex justify-between border-t border-line pt-1 font-semibold"><span>Total</span><span className="font-mono">{total.toFixed(2)}</span></li>}
        </ul>
      )}
      {courierOut ? (
        <form
          aria-label="Record the courier's charge"
          className="space-y-2 rounded-lg border border-line bg-surface p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void (async () => {
              setBusy(true);
              const r = await attempt(recordCourierChargeAction({ deliveryId: view.id, amount: Number(amount), note }));
              setBusy(false);
              if (!r.ok) {
                onError(r.error);
                return;
              }
              setAmount('');
              setNote('');
              reload();
            })();
          }}
        >
          <Field id={`${uid}-ca`} label="What the courier charged (KSh)">
            <input id={`${uid}-ca`} className={fieldClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required autoComplete="off" />
          </Field>
          <Field id={`${uid}-cn`} label="A note (waybill, what it was for)">
            <input id={`${uid}-cn`} className={fieldClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} autoComplete="off" />
          </Field>
          <button type="submit" className={primaryClass} disabled={busy}>
            Record the charge
          </button>
        </form>
      ) : null}
    </section>
  );
}
