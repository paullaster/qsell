'use client';

import { useEffect, useId, useState } from 'react';
import { bookSlotAction, deliverySlotAction, releaseSlotAction } from '@/server/domains/delivery/slot-actions';
import { Chip, Field, attempt, buttonClass, cardClass, fieldClass } from '@/components/ui/screen-kit';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { addDays } from '@/lib/delivery-slot';

type Loaded = Awaited<ReturnType<typeof deliverySlotAction>>;
type Data = Extract<Loaded, { ok: true }>['data'];

const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });
const dayWords = (day: string): string => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

const roomWords = (s: { available: boolean; left: number; weightLeftKg: number | null; why: string | null }): string => (s.available ? `${String(s.left)} left${s.weightLeftKg === null ? '' : `, ${String(s.weightLeftKg)} kg`}` : (s.why ?? 'not available'));

/** The slot a delivery is promised, and the slots its branch offers over a week, with the room left in each. */
export function DeliverySlotPanel({ deliveryId, onError, onDone }: { deliveryId: string; onError: (text: string) => void; onDone: (text: string) => void }) {
  const uid = useId();
  const [data, setData] = useState<Data | null>(null);
  const [from, setFrom] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = (start: string | undefined) => {
    void (async () => {
      const r = await attempt(deliverySlotAction({ deliveryId, from: start }));
      if (r.ok) {
        setData(r.data);
        setPhase('ready');
      } else {
        setPhase('error');
        onError(r.error);
      }
    })();
  };
  useEffect(() => load(from), [from]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (call: Promise<{ ok: true } | { ok: false; error: string }>, ok: string) => {
    setBusy(true);
    const r = await attempt(call);
    setBusy(false);
    if (r.ok) {
      onDone(ok);
      load(from);
    } else {
      onError(r.error);
      load(from);
    }
  };

  const first = data?.offer[0]?.day;
  return (
    <section aria-label="Delivery slot" className={`${cardClass} space-y-3`}>
      <h3 className="text-sm font-bold text-fg-strong">Delivery slot</h3>
      {phase === 'loading' ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading…
        </p>
      ) : null}
      {data?.asked == null ? null : (
        <p className="flex flex-wrap items-center gap-2 text-sm" role="status">
          <Chip tone={data.asked.outcome === 'unavailable' ? 'amber' : 'sky'}>{data.asked.outcome === 'unavailable' ? 'Customer\'s time not kept' : 'Customer chose'}</Chip>
          <span>
            {dayWords(data.asked.day)}, {data.asked.slotName} {data.asked.startsAt} to {data.asked.endsAt}
            {data.asked.note === null ? '' : `. ${data.asked.note} Please let the customer know.`}
          </span>
        </p>
      )}
      {data?.held == null ? (
        <p className="text-sm text-fg-muted">No slot is promised for this delivery yet.</p>
      ) : (
        <div className="space-y-2">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <Chip tone="sky">Promised</Chip>
            <span>
              {data.held.name}: {when(data.held.windowStart)} to {new Date(data.held.windowEnd).toLocaleTimeString('en-GB', { timeStyle: 'short', timeZone: 'Africa/Nairobi' })}
            </span>
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <Field id={`${uid}-r`} label="Why the slot is being let go">
              <input id={`${uid}-r`} className={fieldClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoComplete="off" />
            </Field>
            <InlineConfirm label="Let go of this delivery's slot" action="Let the slot go" confirm="Yes, let it go" busy={busy} onConfirm={() => void act(releaseSlotAction({ deliveryId, reason }), 'The slot is let go.')} />
          </div>
        </div>
      )}
      {data === null ? null : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={buttonClass} disabled={first === undefined} onClick={() => first !== undefined && setFrom(addDays(first, -7))}>
              Earlier days
            </button>
            <button type="button" className={buttonClass} disabled={first === undefined} onClick={() => first !== undefined && setFrom(addDays(first, 7))}>
              Later days
            </button>
          </div>
          {data.offer.every((d) => d.slots.length === 0) ? (
            <p role="status" className="text-sm text-fg-muted">
              This branch offers no slot in these days. Slots are set under Delivery slots.
            </p>
          ) : null}
          <ul className="space-y-2" aria-label="Days and slots">
            {data.offer
              .filter((d) => d.slots.length > 0 || d.closedReason !== null)
              .map((d) => (
                <li key={d.day} className="space-y-1">
                  <p className="text-sm font-semibold text-fg-strong">
                    {dayWords(d.day)}
                    {d.closedReason === null ? null : <span className="ml-2 font-normal text-fg-muted">Closed: {d.closedReason}</span>}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {d.slots.map((s) => (
                      <button
                        key={s.slotId}
                        type="button"
                        className={s.available ? buttonClass : `${buttonClass} opacity-60`}
                        disabled={busy || !s.available}
                        title={s.why ?? undefined}
                        aria-label={`Book ${s.name} on ${dayWords(d.day)}, ${s.startsAt} to ${s.endsAt}, ${roomWords(s)}`}
                        onClick={() => void act(bookSlotAction({ deliveryId, slotId: s.slotId, day: d.day }), 'The slot is promised to the customer.')}
                      >
                        {s.name} {s.startsAt}–{s.endsAt} · {roomWords(s)}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
          </ul>
        </div>
      )}
    </section>
  );
}
