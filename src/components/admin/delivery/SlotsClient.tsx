'use client';

import { use, useId, useState } from 'react';
import { closeDayAction, createSlotAction, reopenDayAction, setSlotActiveAction, slotsScreenAction, updateSlotAction } from '@/server/domains/delivery/slot-actions';
import type { SlotView } from '@/server/domains/delivery/slots';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import type { Choice } from '@/lib/payment-options';
import { WEEKDAYS, WEEKDAY_WORDS } from '@/lib/delivery-slot';

type Loaded = Awaited<ReturnType<typeof slotsScreenAction>>;
type Screen = Extract<Loaded, { ok: true }>['data'];

export function SlotsClient({ firstPromise }: { firstPromise: ReturnType<typeof slotsScreenAction> }) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Body initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Body({ initial }: { initial: Screen }) {
  const [data, setData] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const reload = async (text: string) => {
    const r = await attempt(slotsScreenAction());
    if (r.ok) {
      setData(r.data);
      setNotice({ kind: 'ok', text });
    } else setNotice({ kind: 'error', text: r.error });
  };
  const fail = (text: string) => setNotice({ kind: 'error', text });
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Delivery slots" intro="The windows each branch can promise a customer, with room for so many deliveries a day and a time after which a slot can no longer be booked. A delivery is booked into a slot from its own screen." />
      <Message notice={notice} />
      <SlotForm key="new" onSaved={(t) => void reload(t)} onError={fail} />
      <section aria-label="Slots" className="space-y-3">
        <h3 className="text-sm font-bold text-fg-strong">Slots</h3>
        {data.slots.length === 0 ? (
          <p role="status" className="rounded-xl border border-line bg-surface-raised p-8 text-center text-sm text-fg-muted">
            No slot yet. Add one above, for example a morning window on weekdays.
          </p>
        ) : null}
        <ul className="space-y-3" aria-label="Slot list">
          {data.slots.map((s) => (
            <SlotRow key={`${s.id}-${String(s.version)}`} slot={s} onSaved={(t) => void reload(t)} onError={fail} />
          ))}
        </ul>
      </section>
      <ClosedDays closed={data.closed} onChanged={(t) => void reload(t)} onError={fail} />
    </div>
  );
}

function SlotForm({ slot, onSaved, onError }: { slot?: SlotView; onSaved: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [branch, setBranch] = useState<Choice | null>(slot === undefined ? null : { id: slot.branchId, label: slot.branchName });
  const [name, setName] = useState(slot?.name ?? '');
  const [weekdays, setWeekdays] = useState<number[]>(slot?.weekdays ?? [1, 2, 3, 4, 5]);
  const [startsAt, setStartsAt] = useState(slot?.startsAt ?? '09:00');
  const [endsAt, setEndsAt] = useState(slot?.endsAt ?? '12:00');
  const [capacity, setCapacity] = useState(String(slot?.capacity ?? 10));
  const [cutoff, setCutoff] = useState(String(slot?.cutoffMinutes ?? 120));
  const [busy, setBusy] = useState(false);
  const saveWords = slot === undefined ? 'Add the slot' : 'Save the slot';
  const save = async () => {
    setBusy(true);
    const body = { name, weekdays, startsAt, endsAt, capacity: Number(capacity), cutoffMinutes: Number(cutoff) };
    const r = await attempt(slot === undefined ? createSlotAction({ ...body, branchId: branch?.id ?? '' }) : updateSlotAction({ ...body, id: slot.id, expectedVersion: slot.version }));
    setBusy(false);
    if (r.ok) onSaved(slot === undefined ? 'The slot is added.' : 'The slot is saved. Deliveries already promised it keep the window they were promised.');
    else onError(r.error);
  };
  return (
    <form
      aria-label={slot === undefined ? 'Add a slot' : `Change ${slot.name}`}
      className={`${cardClass} space-y-3`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {slot === undefined ? <h3 className="text-sm font-bold text-fg-strong">Add a slot</h3> : null}
      {slot === undefined ? <ChoicePicker label="Branch" source="delivery-branches" choice={branch} onChoice={setBranch} placeholder="Choose the branch" /> : <p className="text-sm text-fg-muted">Branch: {slot.branchName}</p>}
      <Field id={`${uid}-n`} label="Name">
        <input id={`${uid}-n`} className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" required />
      </Field>
      <fieldset className="space-y-1">
        <legend className="text-xs font-semibold text-fg">Days it runs</legend>
        <div className="flex flex-wrap gap-2">
          {WEEKDAYS.map((w) => (
            <label key={w} className="flex min-h-10 items-center gap-1 rounded-lg border border-line px-3 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={weekdays.includes(w)} onChange={(e) => setWeekdays(e.target.checked ? [...weekdays, w] : weekdays.filter((x) => x !== w))} />
              {(WEEKDAY_WORDS[w] ?? '').slice(0, 3)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field id={`${uid}-s`} label="Starts (Nairobi)">
          <input id={`${uid}-s`} type="time" className={fieldClass} value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
        </Field>
        <Field id={`${uid}-e`} label="Ends (Nairobi)">
          <input id={`${uid}-e`} type="time" className={fieldClass} value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required />
        </Field>
        <Field id={`${uid}-c`} label="Deliveries a day">
          <input id={`${uid}-c`} inputMode="numeric" className={fieldClass} value={capacity} onChange={(e) => setCapacity(e.target.value)} required />
        </Field>
        <Field id={`${uid}-o`} label="Closes (minutes before)">
          <input id={`${uid}-o`} inputMode="numeric" className={fieldClass} value={cutoff} onChange={(e) => setCutoff(e.target.value)} required />
        </Field>
      </div>
      <button type="submit" className={primaryClass} disabled={busy}>
        {busy ? 'Saving…' : saveWords}
      </button>
    </form>
  );
}

function SlotRow({ slot, onSaved, onError }: { slot: SlotView; onSaved: (text: string) => void; onError: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    const r = await attempt(setSlotActiveAction({ id: slot.id, isActive: !slot.isActive, expectedVersion: slot.version }));
    setBusy(false);
    if (r.ok) onSaved(slot.isActive ? 'The slot is stopped. It is no longer offered; deliveries already promised it keep it.' : 'The slot is offered again.');
    else onError(r.error);
  };
  return (
    <li className={`${cardClass} space-y-2`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-fg-strong">
            {slot.name} · {slot.branchName}
          </p>
          <p className="text-sm text-fg">
            {slot.weekdaysWords} · {slot.startsAt} to {slot.endsAt} · room for {slot.capacity} a day · closes {slot.cutoffMinutes} minutes before
          </p>
        </div>
        <Chip tone={slot.isActive ? 'green' : 'gray'}>{slot.isActive ? 'Offered' : 'Stopped'}</Chip>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} onClick={() => setEditing(!editing)}>
          {editing ? 'Close' : `Change ${slot.name}`}
        </button>
        {slot.isActive ? (
          <InlineConfirm label={`Stop offering ${slot.name} at ${slot.branchName}`} action="Stop offering" confirm="Yes, stop it" busy={busy} onConfirm={() => void toggle()} />
        ) : (
          <button type="button" className={buttonClass} disabled={busy} onClick={() => void toggle()}>
            Offer it again
          </button>
        )}
      </div>
      {editing ? <SlotForm slot={slot} onSaved={onSaved} onError={onError} /> : null}
    </li>
  );
}

function ClosedDays({ closed, onChanged, onError }: { closed: Screen['closed']; onChanged: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [day, setDay] = useState('');
  const [branch, setBranch] = useState<Choice | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    const r = await attempt(closeDayAction({ day, branchId: branch?.id ?? '', reason }));
    setBusy(false);
    if (r.ok) {
      setDay('');
      setBranch(null);
      setReason('');
      onChanged('The day is closed: no slot is offered on it.');
    } else onError(r.error);
  };
  return (
    <section aria-label="Closed days" className={`${cardClass} space-y-3`}>
      <h3 className="text-sm font-bold text-fg-strong">Days with no slots</h3>
      <p className="text-xs text-fg-muted">A public holiday or a stocktake. Deliveries already promised that day are not moved; no new slot is offered.</p>
      <form
        aria-label="Close a day"
        className="grid grid-cols-1 items-end gap-3 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Field id={`${uid}-d`} label="Day">
          <input id={`${uid}-d`} type="date" className={fieldClass} value={day} onChange={(e) => setDay(e.target.value)} required />
        </Field>
        <ChoicePicker label="Branch (all if empty)" source="delivery-branches" choice={branch} onChoice={setBranch} placeholder="All branches" clearable />
        <Field id={`${uid}-r`} label="Why">
          <input id={`${uid}-r`} className={fieldClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={120} autoComplete="off" required />
        </Field>
        <button type="submit" className={primaryClass} disabled={busy}>
          Close the day
        </button>
      </form>
      {closed.length === 0 ? (
        <p role="status" className="text-sm text-fg-muted">
          No day is closed.
        </p>
      ) : (
        <ul className="divide-y divide-line text-sm" aria-label="Closed day list">
          {closed.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <strong>{c.day}</strong> · {c.branchName ?? 'All branches'} · {c.reason}
              </span>
              <InlineConfirm
                label={`Open ${c.day} again`}
                action="Open it again"
                confirm="Yes, open it"
                onConfirm={() => {
                  void (async () => {
                    const r = await attempt(reopenDayAction({ id: c.id }));
                    if (r.ok) onChanged('The day is open again.');
                    else onError(r.error);
                  })();
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
