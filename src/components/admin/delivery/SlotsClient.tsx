'use client';

import { use, useId, useState } from 'react';
import Link from 'next/link';
import { closeDayAction, createSlotAction, removeLeadTimeAction, reopenDayAction, setLeadTimeAction, setShopperChoiceAction, setSlaSettingsAction, setSlotActiveAction, slotsScreenAction, updateSlotAction } from '@/server/domains/delivery/slot-actions';
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
      <ShopperChoicePanel choice={data.shopperChoice} onChanged={(t) => void reload(t)} onError={fail} />
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
      <LeadTimes leads={data.leads} onChanged={(t) => void reload(t)} onError={fail} />
      <SlaPanel textsGoThrough={data.textsGoThrough} sla={data.sla} onChanged={(t) => void reload(t)} onError={fail} />
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
  const [maxWeight, setMaxWeight] = useState(slot?.maxWeightKg == null ? '' : String(slot.maxWeightKg));
  const [busy, setBusy] = useState(false);
  const saveWords = slot === undefined ? 'Add the slot' : 'Save the slot';
  const save = async () => {
    setBusy(true);
    const body = { name, weekdays, startsAt, endsAt, capacity: Number(capacity), cutoffMinutes: Number(cutoff), maxWeightKg: maxWeight.trim() === '' ? null : Number(maxWeight) };
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
      <Field id={`${uid}-w`} label="Most it can carry in a day, in kg (empty for no limit)">
        <input id={`${uid}-w`} inputMode="decimal" className={fieldClass} value={maxWeight} onChange={(e) => setMaxWeight(e.target.value)} autoComplete="off" />
      </Field>
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
            {slot.weekdaysWords} · {slot.startsAt} to {slot.endsAt} · room for {slot.capacity} a day{slot.maxWeightKg === null ? '' : `, up to ${String(slot.maxWeightKg)} kg`} · closes {slot.cutoffMinutes} minutes before
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

/** How long the goods need before they can go, for a zone or an item: a slot cannot start before the longest that applies to a delivery. */
function LeadTimes({ leads, onChanged, onError }: { leads: Screen['leads']; onChanged: (text: string) => void; onError: (text: string) => void }) {
  return (
    <section aria-label="Lead times" className={`${cardClass} space-y-3`}>
      <h3 className="text-sm font-bold text-fg-strong">How long the goods need</h3>
      <p className="text-xs text-fg-muted">The least time from the order to the goods being ready, for a delivery zone (far away) or for an item (fresh fish, made to order, large goods). A delivery cannot be promised a slot that starts before the longest of these that apply to it and the branch&apos;s own handling time.</p>
      <LeadForm kind="zone" onChanged={onChanged} onError={onError} />
      <LeadForm kind="item" onChanged={onChanged} onError={onError} />
      {leads.length === 0 ? (
        <p role="status" className="text-sm text-fg-muted">
          No lead time is set.
        </p>
      ) : (
        <ul className="divide-y divide-line text-sm" aria-label="Lead time list">
          {leads.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <strong>{l.name}</strong> ({l.kind === 'zone' ? 'zone' : 'item'}) · {l.words}
                {l.note === null ? '' : ` · ${l.note}`}
              </span>
              <InlineConfirm
                label={`Remove the lead time of ${l.name}`}
                action="Remove"
                confirm="Yes, remove it"
                onConfirm={() => {
                  void (async () => {
                    const r = await attempt(removeLeadTimeAction({ id: l.id }));
                    if (r.ok) onChanged('The lead time is removed.');
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

function LeadForm({ kind, onChanged, onError }: { kind: 'zone' | 'item'; onChanged: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [pick, setPick] = useState<Choice | null>(null);
  const [minutes, setMinutes] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const word = kind === 'zone' ? 'zone' : 'item';
  const save = async () => {
    setBusy(true);
    const r = await attempt(setLeadTimeAction({ kind, refId: pick?.id ?? '', minutes: Number(minutes), note }));
    setBusy(false);
    if (r.ok) {
      setPick(null);
      setMinutes('');
      setNote('');
      onChanged('The lead time is saved.');
    } else onError(r.error);
  };
  return (
    <form
      aria-label={`Lead time for ${kind === 'zone' ? 'a zone' : 'an item'}`}
      className="grid grid-cols-1 items-end gap-3 sm:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <ChoicePicker label={kind === 'zone' ? 'Zone' : 'Item'} source={kind === 'zone' ? 'lead-time-zones' : 'lead-time-products'} choice={pick} onChoice={setPick} placeholder={kind === 'zone' ? 'Choose a zone' : 'Search products'} />
      <Field id={`${uid}-m`} label={`Minutes the ${word} needs`}>
        <input id={`${uid}-m`} inputMode="numeric" className={fieldClass} value={minutes} onChange={(e) => setMinutes(e.target.value)} required />
      </Field>
      <Field id={`${uid}-n`} label="Note">
        <input id={`${uid}-n`} className={fieldClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} autoComplete="off" />
      </Field>
      <button type="submit" className={primaryClass} disabled={busy}>
        Save the {word}&apos;s lead time
      </button>
    </form>
  );
}

/** Whether the shop lets a shopper choose a delivery time. Off: every delivery is planned by dispatch and the checkout shows no times. */
function ShopperChoicePanel({ choice, onChanged, onError }: { choice: Screen['shopperChoice']; onChanged: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [on, setOn] = useState(choice.enabled);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await attempt(setShopperChoiceAction({ enabled: on, expectedVersion: choice.version }));
    setBusy(false);
    if (r.ok) onChanged(r.data.enabled ? 'Saved. Shoppers can now choose a delivery time at checkout.' : 'Saved. The checkout no longer offers delivery times; you plan every delivery.');
    else onError(r.error);
  };
  return (
    <form
      key={choice.version}
      aria-label="Shopper choice"
      className={`${cardClass} space-y-3`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3 className="text-sm font-bold text-fg-strong">Delivery time at checkout</h3>
      <label htmlFor={`${uid}-on`} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-fg">
        <input id={`${uid}-on`} type="checkbox" className="h-5 w-5 accent-indigo-600" checked={on} onChange={(e) => setOn(e.target.checked)} />
        Let shoppers choose a delivery time at checkout
      </label>
      <p className="text-xs text-fg-muted">
        On: a shopper having an order delivered sees the earliest free time from the slots below and may choose one (it is optional). Off: the checkout shows no times, orders are delivered when you plan them, and you can still book a slot for any delivery from its own screen.
        Orders whose shopper has already chosen a time keep it.
      </p>
      <button type="submit" className={primaryClass} disabled={busy || on === choice.enabled}>
        Save
      </button>
    </form>
  );
}

/** When a delivery is told it is at risk, and when a late one goes up to the supervisor. */
function SlaPanel({ sla, textsGoThrough, onChanged, onError }: { sla: Screen['sla']; textsGoThrough: Screen['textsGoThrough']; onChanged: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [atRisk, setAtRisk] = useState(String(sla.atRiskMinutes));
  const [escalate, setEscalate] = useState(String(sla.escalateAfterMinutes));
  const [dispatchTo, setDispatchTo] = useState(sla.notifyDispatch.join(', '));
  const [supervisorTo, setSupervisorTo] = useState(sla.notifySupervisor.join(', '));
  const [dispatchPhones, setDispatchPhones] = useState(sla.notifyDispatchPhones.join(', '));
  const [supervisorPhones, setSupervisorPhones] = useState(sla.notifySupervisorPhones.join(', '));
  const [textRider, setTextRider] = useState(sla.textTheRider);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await attempt(setSlaSettingsAction({ atRiskMinutes: Number(atRisk), escalateAfterMinutes: Number(escalate), notifyDispatch: dispatchTo, notifySupervisor: supervisorTo, notifyDispatchPhones: dispatchPhones, notifySupervisorPhones: supervisorPhones, textTheRider: textRider, expectedVersion: sla.version }));
    setBusy(false);
    if (r.ok) {
      // What was saved, not what was typed: the server writes addresses in lower case and once each.
      setDispatchTo(r.data.notifyDispatch.join(', '));
      setSupervisorTo(r.data.notifySupervisor.join(', '));
      setDispatchPhones(r.data.notifyDispatchPhones.join(', '));
      setSupervisorPhones(r.data.notifySupervisorPhones.join(', '));
      onChanged('Saved. The Late deliveries screen uses these from now on.');
    } else onError(r.error);
  };
  return (
    <form
      key={sla.version}
      aria-label="Lateness"
      className={`${cardClass} space-y-3`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3 className="text-sm font-bold text-fg-strong">When a delivery counts as late</h3>
      <p className="text-xs text-fg-muted">A delivery promised a window is at risk when it is this close to the end of the window (or the window has begun and it is not on its way), late once the window has ended, and goes up to the supervisor after being late for the second time below.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field id={`${uid}-a`} label="At risk this many minutes before the window ends">
          <input id={`${uid}-a`} inputMode="numeric" className={fieldClass} value={atRisk} onChange={(e) => setAtRisk(e.target.value)} required />
        </Field>
        <Field id={`${uid}-e`} label="Tell the supervisor after this many minutes late">
          <input id={`${uid}-e`} inputMode="numeric" className={fieldClass} value={escalate} onChange={(e) => setEscalate(e.target.value)} required />
        </Field>
        <Field id={`${uid}-d`} label="Mail the dispatchers when a delivery is at risk or late">
          <input id={`${uid}-d`} type="text" inputMode="email" className={fieldClass} value={dispatchTo} onChange={(e) => setDispatchTo(e.target.value)} placeholder="dispatch@example.com, ops@example.com" autoComplete="off" />
        </Field>
        <Field id={`${uid}-s`} label="Mail the supervisors when it has been late too long">
          <input id={`${uid}-s`} type="text" inputMode="email" className={fieldClass} value={supervisorTo} onChange={(e) => setSupervisorTo(e.target.value)} placeholder="supervisor@example.com" autoComplete="off" />
        </Field>
        <Field id={`${uid}-dp`} label="Text the dispatchers when a delivery is at risk or late" hint="Mobile numbers, separated by commas.">
          <input id={`${uid}-dp`} type="text" inputMode="tel" className={fieldClass} value={dispatchPhones} onChange={(e) => setDispatchPhones(e.target.value)} placeholder="0712 345 678, 0722 111 222" autoComplete="off" />
        </Field>
        <Field id={`${uid}-sp`} label="Text the supervisors when it has been late too long" hint="Mobile numbers, separated by commas.">
          <input id={`${uid}-sp`} type="text" inputMode="tel" className={fieldClass} value={supervisorPhones} onChange={(e) => setSupervisorPhones(e.target.value)} placeholder="0733 000 111" autoComplete="off" />
        </Field>
        <label htmlFor={`${uid}-tr`} className="flex min-h-11 cursor-pointer items-center gap-3 self-end text-sm text-fg">
          <input id={`${uid}-tr`} type="checkbox" className="h-5 w-5 accent-indigo-600" checked={textRider} onChange={(e) => setTextRider(e.target.checked)} />
          Also text the rider whose run holds the delivery
        </label>
        <button type="submit" className={`${primaryClass} self-end`} disabled={busy}>
          Save
        </button>
      </div>
      <p className="text-xs text-fg-muted">Addresses and numbers are separated by commas, up to ten for each. Each level is mailed and texted once for a delivery and a window. Leave a list empty to send nothing to it; the Late deliveries screen shows everything either way. The rider is texted on the number saved on their rider record, for at risk and late (not for the supervisor level).</p>
      <p role="status" className="text-xs text-fg-muted">
        {textsGoThrough === null ? (
          <>
            No SMS provider is connected, so no text can be sent yet. <Link className="font-semibold underline" href="/admin/settings/sms">
              Connect one in Settings › SMS providers
            </Link>.
          </>
        ) : (
          `Texts go through the connection called “${textsGoThrough}”. A text that cannot be sent for three hours is dropped, because by then it is no use.`
        )}
      </p>
    </form>
  );
}
