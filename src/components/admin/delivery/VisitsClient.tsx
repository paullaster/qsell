'use client';

import { use, useId, useState } from 'react';
import { assignCrewAction, bookVisitAction, cancelVisitAction, completeVisitAction, giveBackMaterialAction, moveVisitAction, recordMaterialAction, signOffVisitAction, startVisitAction, tickVisitItemAction, visitsPageAction } from '@/server/domains/delivery/visit-actions';
import type { MaterialView, VisitView } from '@/server/domains/delivery/visits';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { usePagedList } from '@/components/ui/usePagedList';
import type { Choice } from '@/lib/payment-options';
import { VISIT_STATUS_WORDS, fromNairobiInput, itemsFromLines, toNairobiInput, visitActionsFrom, type VisitStatus } from '@/lib/visit';

type Loaded = Awaited<ReturnType<typeof visitsPageAction>>;

const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });
const TONES: Record<VisitStatus, 'green' | 'amber' | 'red' | 'sky' | 'gray'> = { scheduled: 'amber', crew_assigned: 'sky', on_site: 'sky', completed: 'amber', signed_off: 'green', cancelled: 'gray' };
const FILTERS: { id: string; label: string }[] = [
  { id: 'live', label: 'Coming up' },
  { id: 'signed_off', label: 'Signed off' },
  { id: 'cancelled', label: 'Cancelled' },
];

export function VisitsClient({ firstPromise }: { firstPromise: ReturnType<typeof visitsPageAction> }) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Screen /> : <LoadFailed error={res.error} />;
}

function Screen() {
  const [notice, setNotice] = useState<Notice>(null);
  const [status, setStatus] = useState('live');
  const list = usePagedList<VisitView, { status: string }>({
    load: async (filters, cursor) => {
      const result = await visitsPageAction({ status: filters.status, cursor });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, data: { rows: result.data.rows, nextCursor: result.data.nextCursor } };
    },
    filters: { status },
  });
  const done = (text: string) => {
    setNotice({ kind: 'ok', text });
    list.reload();
  };
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Visits" intro="A crew goes to a customer at an agreed time, for example to install what they bought. Book it, name the crew, and the crew ticks the checklist on site. The order is delivered when the customer has signed the work off." />
      <Message notice={notice} />
      <BookPanel onBooked={() => done('The visit is booked.')} onError={(text) => setNotice({ kind: 'error', text })} />
      <section aria-label="Visits" className="space-y-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={status === f.id ? primaryClass : buttonClass} aria-pressed={status === f.id} onClick={() => setStatus(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        {list.phase === 'error' ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {list.error}{' '}
            <button type="button" className={buttonClass} onClick={list.retry}>
              Try again
            </button>
          </p>
        ) : null}
        {list.phase === 'loading' ? (
          <p role="status" className="text-sm text-fg-muted">
            Loading…
          </p>
        ) : null}
        {list.phase !== 'loading' && list.phase !== 'error' && list.rows.length === 0 ? (
          <p role="status" className="rounded-xl border border-line bg-surface-raised p-8 text-center text-sm text-fg-muted">
            No visit here yet. Book one above for an order that has been paid.
          </p>
        ) : null}
        <ul className="space-y-3" aria-label="Visit list">
          {list.rows.map((v) => (
            <VisitCard key={`${v.id}-${String(v.version)}`} visit={v} onDone={done} onError={(text) => setNotice({ kind: 'error', text })} />
          ))}
        </ul>
        {list.cursor !== null ? (
          <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
            {list.phase === 'more' ? 'Loading…' : 'Show more'}
          </button>
        ) : null}
      </section>
    </div>
  );
}

/** A crew as typed: people chosen one at a time from the staff, shown as chips that can be taken off. */
function CrewPicker({ label, crew, onChange }: { label: string; crew: Choice[]; onChange: (next: Choice[]) => void }) {
  const [pick, setPick] = useState<Choice | null>(null);
  return (
    <div className="space-y-2">
      <ChoicePicker
        label={label}
        source="visit-crew"
        choice={pick}
        onChoice={(c) => {
          if (c !== null && !crew.some((m) => m.id === c.id)) onChange([...crew, c]);
          setPick(null);
        }}
        placeholder="Search the staff"
      />
      {crew.length === 0 ? null : (
        <ul className="flex flex-wrap gap-2" aria-label="Crew chosen">
          {crew.map((m) => (
            <li key={m.id} className="flex items-center gap-1 rounded-full border border-line bg-surface-sunken py-1 pl-3 pr-1 text-sm">
              {m.label}
              <button type="button" className="min-h-10 min-w-10 rounded-full text-fg-muted hover:text-fg-strong" aria-label={`Take ${m.label} off the crew`} onClick={() => onChange(crew.filter((x) => x.id !== m.id))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BookPanel({ onBooked, onError }: { onBooked: () => void; onError: (text: string) => void }) {
  const uid = useId();
  const [order, setOrder] = useState<Choice | null>(null);
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [address, setAddress] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState('');
  const [crew, setCrew] = useState<Choice[]>([]);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await attempt(
      bookVisitAction({ orderId: order?.id ?? '', startsAt: fromNairobiInput(startsAt), endsAt: fromNairobiInput(endsAt), address, contactName, contactPhone, notes, items: itemsFromLines(items), crewIds: crew.map((c) => c.id) }),
    );
    setBusy(false);
    if (!r.ok) {
      onError(r.error);
      return;
    }
    setOrder(null);
    setStartsAt('');
    setEndsAt('');
    setAddress('');
    setContactName('');
    setContactPhone('');
    setNotes('');
    setItems('');
    setCrew([]);
    onBooked();
  };
  return (
    <form
      aria-label="Book a visit"
      className={`${cardClass} space-y-3`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3 className="text-sm font-bold text-fg-strong">Book a visit</h3>
      <ChoicePicker label="Order" source="visit-orders" choice={order} onChoice={setOrder} placeholder="Search by order number, customer or phone" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={`${uid}-s`} label="Starts (Nairobi time)">
          <input id={`${uid}-s`} type="datetime-local" className={fieldClass} value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
        </Field>
        <Field id={`${uid}-e`} label="Ends (Nairobi time)">
          <input id={`${uid}-e`} type="datetime-local" className={fieldClass} value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required />
        </Field>
      </div>
      <Field id={`${uid}-a`} label="Address the crew goes to">
        <input id={`${uid}-a`} className={fieldClass} value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} autoComplete="off" required />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={`${uid}-n`} label="Who to ask for">
          <input id={`${uid}-n`} className={fieldClass} value={contactName} onChange={(e) => setContactName(e.target.value)} maxLength={120} autoComplete="off" />
        </Field>
        <Field id={`${uid}-p`} label="Their phone">
          <input id={`${uid}-p`} type="tel" className={fieldClass} value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} maxLength={40} autoComplete="off" />
        </Field>
      </div>
      <Field id={`${uid}-c`} label="Checklist, one item to a line">
        <textarea id={`${uid}-c`} className={fieldClass} rows={3} value={items} onChange={(e) => setItems(e.target.value)} required />
      </Field>
      <Field id={`${uid}-o`} label="Notes for the crew">
        <input id={`${uid}-o`} className={fieldClass} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={600} autoComplete="off" />
      </Field>
      <CrewPicker label="Crew (you can name them later)" crew={crew} onChange={setCrew} />
      <button type="submit" className={primaryClass} disabled={busy}>
        {busy ? 'Booking…' : 'Book the visit'}
      </button>
    </form>
  );
}

function VisitCard({ visit, onDone, onError }: { visit: VisitView; onDone: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<'crew' | 'move' | 'signoff' | null>(null);
  const [crew, setCrew] = useState<Choice[]>(visit.crew.map((m) => ({ id: m.userId, label: m.name })));
  const [startsAt, setStartsAt] = useState(toNairobiInput(visit.startsAt));
  const [endsAt, setEndsAt] = useState(toNairobiInput(visit.endsAt));
  const [reason, setReason] = useState('');
  const [name, setName] = useState('');
  const actions = visitActionsFrom(visit.status);
  const ticked = visit.items.filter((i) => i.done).length;

  const go = async (call: Promise<{ ok: true } | { ok: false; error: string }>, ok: string) => {
    setBusy(true);
    const r = await attempt(call);
    setBusy(false);
    if (r.ok) onDone(ok);
    else onError(r.error);
  };

  return (
    <li className={`${cardClass} space-y-3`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-fg-strong">Order {visit.orderNumber}</p>
          <p className="text-sm text-fg">
            {when(visit.startsAt)} to {when(visit.endsAt)}
          </p>
          <p className="break-words text-sm text-fg-muted">{visit.address}</p>
          {visit.contactName === null && visit.contactPhone === null ? null : (
            <p className="text-sm text-fg-muted">
              {[visit.contactName, visit.contactPhone].filter((p): p is string => p !== null).join(' · ')}
            </p>
          )}
          {visit.notes === null ? null : <p className="text-sm text-fg-muted">{visit.notes}</p>}
        </div>
        <Chip tone={TONES[visit.status]}>{VISIT_STATUS_WORDS[visit.status]}</Chip>
      </div>

      <p className="text-sm text-fg">{visit.crew.length === 0 ? 'No crew yet.' : `Crew: ${visit.crew.map((m) => m.name).join(', ')}`}</p>

      <ul className="space-y-1" aria-label={`Checklist for order ${visit.orderNumber}`}>
        {visit.items.map((i) => (
          <li key={i.id}>
            <label className="flex min-h-10 items-center gap-2 text-sm">
              <input type="checkbox" className="h-5 w-5" checked={i.done} disabled={busy || visit.status !== 'on_site'} onChange={(e) => void go(tickVisitItemAction({ id: visit.id, itemId: i.id, done: e.target.checked }), 'Ticked.')} />
              {i.label}
            </label>
          </li>
        ))}
      </ul>
      <p className="text-xs text-fg-muted">
        {ticked} of {visit.items.length} ticked
        {visit.startedAt === null ? '' : ` · crew on site ${when(visit.startedAt)}`}
        {visit.completedAt === null ? '' : ` · work done ${when(visit.completedAt)}`}
        {visit.signedOffAt === null ? '' : ` · signed off by ${visit.signedOffBy ?? ''} ${when(visit.signedOffAt)}`}
        {visit.cancelReason === null ? '' : ` · cancelled: ${visit.cancelReason}`}
      </p>

      {visit.materials.length === 0 && visit.status !== 'on_site' && visit.status !== 'completed' ? null : (
        <MaterialsPanel visit={visit} busy={busy} onDone={onDone} onError={onError} />
      )}

      {actions.length === 0 ? null : (
        <div className="flex flex-wrap gap-2">
          {actions.includes('assign') ? (
            <button type="button" className={buttonClass} onClick={() => setPanel(panel === 'crew' ? null : 'crew')}>
              {visit.crew.length === 0 ? 'Name the crew' : 'Change the crew'}
            </button>
          ) : null}
          {actions.includes('reschedule') ? (
            <button type="button" className={buttonClass} onClick={() => setPanel(panel === 'move' ? null : 'move')}>
              Move the visit
            </button>
          ) : null}
          {actions.includes('start') ? (
            <button type="button" className={primaryClass} disabled={busy} onClick={() => void go(startVisitAction({ id: visit.id }), 'The crew is on site.')}>
              Crew is on site
            </button>
          ) : null}
          {actions.includes('complete') ? (
            <button type="button" className={primaryClass} disabled={busy} onClick={() => void go(completeVisitAction({ id: visit.id }), 'The work is marked done.')}>
              Mark the work done
            </button>
          ) : null}
          {actions.includes('sign_off') ? (
            <button type="button" className={primaryClass} onClick={() => setPanel(panel === 'signoff' ? null : 'signoff')}>
              Customer&apos;s sign-off
            </button>
          ) : null}
        </div>
      )}

      {panel === 'crew' ? (
        <form
          aria-label={`Crew for order ${visit.orderNumber}`}
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void go(assignCrewAction({ id: visit.id, crewIds: crew.map((c) => c.id), expectedVersion: visit.version }), 'The crew is set.');
          }}
        >
          <CrewPicker label="Add a person" crew={crew} onChange={setCrew} />
          <button type="submit" className={primaryClass} disabled={busy}>
            Save the crew
          </button>
        </form>
      ) : null}

      {panel === 'move' ? (
        <form
          aria-label={`Move the visit for order ${visit.orderNumber}`}
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void go(moveVisitAction({ id: visit.id, startsAt: fromNairobiInput(startsAt), endsAt: fromNairobiInput(endsAt), reason, expectedVersion: visit.version }), 'The visit is moved.');
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id={`${uid}-ms`} label="New start (Nairobi time)">
              <input id={`${uid}-ms`} type="datetime-local" className={fieldClass} value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
            </Field>
            <Field id={`${uid}-me`} label="New end (Nairobi time)">
              <input id={`${uid}-me`} type="datetime-local" className={fieldClass} value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required />
            </Field>
          </div>
          <Field id={`${uid}-mr`} label="Why it is being moved">
            <input id={`${uid}-mr`} className={fieldClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoComplete="off" required />
          </Field>
          <button type="submit" className={primaryClass} disabled={busy}>
            Move it
          </button>
        </form>
      ) : null}

      {panel === 'signoff' ? (
        <form
          aria-label={`Sign-off for order ${visit.orderNumber}`}
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void go(signOffVisitAction({ id: visit.id, name }), 'Signed off. The order is delivered.');
          }}
        >
          <Field id={`${uid}-so`} label="Who signed the work off for the customer">
            <input id={`${uid}-so`} className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" required />
          </Field>
          <button type="submit" className={primaryClass} disabled={busy}>
            Record the sign-off
          </button>
        </form>
      ) : null}

      {actions.includes('cancel') ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field id={`${uid}-cr`} label="Why it is being cancelled">
            <input id={`${uid}-cr`} className={fieldClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoComplete="off" />
          </Field>
          <InlineConfirm
            label={`Cancel the visit for order ${visit.orderNumber}`}
            action="Cancel the visit"
            confirm="Yes, cancel it"
            busy={busy}
            onConfirm={() => void go(cancelVisitAction({ id: visit.id, reason, expectedVersion: visit.version }), 'The visit is cancelled.')}
          />
        </div>
      ) : null}
    </li>
  );
}

/** What the crew used on the visit, and the form to add more or give some back while the visit is open for it. */
function MaterialsPanel({ visit, busy, onDone, onError }: { visit: VisitView; busy: boolean; onDone: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const open = visit.status === 'on_site' || visit.status === 'completed';
  const [product, setProduct] = useState<Choice | null>(null);
  const [location, setLocation] = useState<Choice | null>(null);
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [working, setWorking] = useState(false);
  const add = async () => {
    setWorking(true);
    const r = await attempt(recordMaterialAction({ id: visit.id, productId: product?.id ?? '', locationId: location?.id ?? '', quantity: Number(quantity), note }));
    setWorking(false);
    if (r.ok) {
      setProduct(null);
      setLocation(null);
      setQuantity('');
      setNote('');
      onDone('The material is recorded and taken from stock.');
    } else onError(r.error);
  };
  return (
    <section aria-label={`Materials for order ${visit.orderNumber}`} className="space-y-2 rounded-lg border border-line p-3">
      <h4 className="text-sm font-bold text-fg-strong">Materials used</h4>
      {visit.materials.length === 0 ? (
        <p className="text-sm text-fg-muted">None recorded.</p>
      ) : (
        <ul className="divide-y divide-line text-sm" aria-label={`Materials list for order ${visit.orderNumber}`}>
          {visit.materials.map((m) => (
            <MaterialRow key={m.id} visitId={visit.id} material={m} open={open} busy={busy || working} onDone={onDone} onError={onError} />
          ))}
        </ul>
      )}
      {open ? (
        <form
          aria-label={`Use a material on order ${visit.orderNumber}`}
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <ChoicePicker label="Material" source="visit-products" choice={product} onChoice={setProduct} placeholder="Search products that hold stock" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id={`${uid}-q`} label="How much was used">
              <input id={`${uid}-q`} inputMode="decimal" className={fieldClass} value={quantity} onChange={(e) => setQuantity(e.target.value)} autoComplete="off" required />
            </Field>
            <ChoicePicker label="Taken from (the main shelf if left empty)" source="visit-locations" choice={location} onChoice={setLocation} placeholder="Choose a place" clearable />
          </div>
          <Field id={`${uid}-n`} label="Note">
            <input id={`${uid}-n`} className={fieldClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} autoComplete="off" />
          </Field>
          <button type="submit" className={primaryClass} disabled={busy || working}>
            {working ? 'Saving…' : 'Take it from stock'}
          </button>
        </form>
      ) : null}
    </section>
  );
}

function MaterialRow({ visitId, material, open, busy, onDone, onError }: { visitId: string; material: MaterialView; open: boolean; busy: boolean; onDone: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [reason, setReason] = useState('');
  const back = material.quantity < 0;
  return (
    <li className="space-y-1 py-2">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-fg-strong">
          {back ? 'Given back' : 'Used'} {Math.abs(material.quantity)} × {material.productName}
        </span>
        <span className="text-xs text-fg-muted">from {material.locationName}</span>
        {material.givenBack ? <Chip tone="gray">Was given back</Chip> : null}
      </p>
      {material.note === null ? null : <p className="text-xs text-fg-muted">{material.note}</p>}
      {open && material.canGiveBack ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field id={`${uid}-r`} label="Why it is being given back">
            <input id={`${uid}-r`} className={fieldClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoComplete="off" />
          </Field>
          <InlineConfirm
            label={`Give back ${material.productName}`}
            action="Give it back"
            confirm="Yes, give it back"
            busy={busy}
            onConfirm={() => {
              void (async () => {
                const r = await attempt(giveBackMaterialAction({ id: visitId, materialId: material.id, reason }));
                if (r.ok) onDone('The material is back in stock.');
                else onError(r.error);
              })();
            }}
          />
        </div>
      ) : null}
    </li>
  );
}
