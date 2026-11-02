'use client';

import { use, useId, useState } from 'react';
import Link from 'next/link';
import { deliveryStepAction, type deliveryAction } from '@/server/domains/delivery/document-actions';
import type { DeliveryView } from '@/server/domains/delivery/documents';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { METHOD_WORDS } from '@/lib/delivery-methods';
import type { DeliveryAction, DeliveryStatus } from '@/lib/delivery-document';
import type { Choice } from '@/lib/payment-options';

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

const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });
const qty = (n: number): string => String(n);

export function DeliveryDetailClient({ viewPromise, canFulfil }: { viewPromise: ReturnType<typeof deliveryAction>; canFulfil: Promise<boolean> }) {
  const res: Loaded = use(viewPromise);
  const allowed = use(canFulfil);
  return res.ok ? <DeliveryScreen initial={res.data} canFulfil={allowed} /> : <LoadFailed error={res.error} />;
}

function whereTo(view: DeliveryView): string {
  const a = view.destination.address;
  const words = a === null ? '' : [a.area, a.town, a.county].filter((p): p is string => p !== null && p !== '').join(', ');
  const pin = view.destination.pin === null ? '' : `Pin ${String(view.destination.pin.latitude)}, ${String(view.destination.pin.longitude)}`;
  return [words, pin].filter((p) => p !== '').join(' · ');
}

function DeliveryScreen({ initial, canFulfil }: { initial: DeliveryView; canFulfil: boolean }) {
  const uid = useId();
  const [view, setView] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [receivedBy, setReceivedBy] = useState('');
  const [courierName, setCourierName] = useState(initial.courierName ?? '');
  const [tracking, setTracking] = useState(initial.trackingNumber ?? '');
  const [failure, setFailure] = useState<Choice | null>(null);
  const [recipientName, setRecipientName] = useState(initial.recipientName ?? '');
  const [recipientPhone, setRecipientPhone] = useState(initial.recipientPhone ?? '');
  const [notes, setNotes] = useState(initial.notes ?? '');

  const run = async (step: DeliveryAction | 'amend', extra: Record<string, unknown>, done: string, after?: () => void) => {
    setBusy(true);
    setNotice(null);
    const result = await attempt(deliveryStepAction({ deliveryId: view.id, step, expectedVersion: view.version, ...extra }));
    setBusy(false);
    if (!result.ok) {
      setNotice({ kind: 'error', text: result.error });
      return;
    }
    setView(result.data);
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

      <section aria-label="What it carries" className={`${cardClass} space-y-3`}>
        <h2 className="text-sm font-bold text-fg-strong">What it carries</h2>
        <ul className="divide-y divide-line">
          {view.lines.map((line) => (
            <li key={line.id} className="grid grid-cols-1 gap-2 py-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center sm:gap-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-fg-strong">{line.productName}</p>
                <p className="font-mono text-xs text-fg-muted">{line.sku}</p>
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
              {can('reattempt') ? (
                <button type="button" className={primaryClass} disabled={busy} onClick={() => void run('reattempt', {}, DONE.reattempt)}>
                  Try again
                </button>
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
