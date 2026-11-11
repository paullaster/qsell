'use client';

import { use, useId, useState } from 'react';
import { addStaffRiderAction, changeRiderAction, createOwnRiderAction, resetRiderPasswordAction, updateRiderAction, ridersPageAction, riderSettingsAction, setRiderKindsAction, setRiderProofAction } from '@/server/domains/delivery/rider-actions';
import type { RiderView } from '@/server/domains/delivery/riders';
import type { PinStatus } from '@/server/domains/delivery/rider-pins';
import { RiderPinPanel } from './RiderPinPanel';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { usePagedList } from '@/components/ui/usePagedList';
import { PROOF_HELP, PROOF_RULES, PROOF_WORDS, type ProofRule } from '@/lib/delivery-proof';
import { RIDER_KIND_HELP, RIDER_KIND_WORDS, type RiderChange, type RiderStatus } from '@/lib/delivery-rider';
import type { Choice } from '@/lib/payment-options';

type Loaded = Awaited<ReturnType<typeof riderSettingsAction>>;
type Settings = Extract<Loaded, { ok: true }>['data'];

const TONE: Record<RiderStatus, 'green' | 'amber' | 'gray'> = { active: 'green', paused: 'amber', ended: 'gray' };

export function RidersClient({ settingsPromise }: { settingsPromise: ReturnType<typeof riderSettingsAction> }) {
  const res: Loaded = use(settingsPromise);
  return res.ok ? <Screen initial={res.data} /> : <LoadFailed error={res.error} />;
}

type RiderRow = RiderView & { pin: PinStatus | null };

function Screen({ initial }: { initial: Settings }) {
  const [settings, setSettings] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [kind, setKind] = useState<Choice | null>(null);
  const [status, setStatus] = useState<Choice | null>(null);
  const list = usePagedList<RiderRow, { kind: string; status: string }>({
    load: async (filters, cursor) => {
      const result = await ridersPageAction({ kind: filters.kind, status: filters.status, cursor });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, data: { rows: result.data.rows, nextCursor: result.data.nextCursor } };
    },
    filters: { kind: kind?.id ?? '', status: status?.id ?? '' },
  });

  /** After a change the list starts over and the counts that guard switching a kind off are read again. */
  const changed = async (text: string) => {
    list.reload();
    const fresh = await attempt(riderSettingsAction());
    if (fresh.ok) setSettings(fresh.data);
    setNotice({ kind: 'ok', text });
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Riders" intro="The people who carry deliveries. Choose whether your own staff ride, whether riders get an account of their own, or both." />
      <Message notice={notice} />
      <KindsPanel settings={settings} onSaved={(s) => { setSettings(s); setNotice({ kind: 'ok', text: 'Saved. This is who can be a rider from now on.' }); }} onError={(text) => setNotice({ kind: 'error', text })} />
      <ProofPanel settings={settings} onSaved={(s) => { setSettings(s); setNotice({ kind: 'ok', text: 'Saved. Riders are asked for this from now on.' }); }} onError={(text) => setNotice({ kind: 'error', text })} />
      <AddPanel settings={settings} onAdded={(text) => void changed(text)} onError={(text) => setNotice({ kind: 'error', text })} />

      <section aria-label="Riders" className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ChoicePicker label="Kind" source="delivery-rider-kinds" choice={kind} onChoice={setKind} placeholder="All kinds" clearable />
          <ChoicePicker label="State" source="delivery-rider-statuses" choice={status} onChoice={setStatus} placeholder="All" clearable />
        </div>
        {list.phase === 'error' ? (
          <p role="alert" className="text-sm text-red-700">
            {list.error}{' '}
            <button type="button" className={buttonClass} onClick={list.retry}>
              Try again
            </button>
          </p>
        ) : null}
        {list.phase === 'loading' ? (
          <p role="status" className="text-sm text-fg-muted">
            Loading riders…
          </p>
        ) : null}
        {list.phase !== 'loading' && list.phase !== 'error' && list.rows.length === 0 ? (
          <p role="status" className="rounded-xl border border-line bg-surface-raised p-8 text-center text-sm text-fg-muted">
            {kind === null && status === null ? 'No riders yet. Add one above.' : 'No rider matches.'}
          </p>
        ) : null}
        <ul className="space-y-3" aria-label="List of riders">
          {list.rows.map((r) => (
            <RiderCard key={r.id} rider={r} onDone={(text) => void changed(text)} onError={(text) => setNotice({ kind: 'error', text })} />
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

function KindsPanel({ settings, onSaved, onError }: { settings: Settings; onSaved: (s: Settings) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [staff, setStaff] = useState(settings.allowStaff);
  const [own, setOwn] = useState(settings.allowSeparate);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const result = await attempt(setRiderKindsAction({ allowStaff: staff, allowSeparate: own, expectedVersion: settings.version }));
    setBusy(false);
    if (result.ok) onSaved(result.data);
    else onError(result.error);
  };
  return (
    <section aria-label="Who rides" className={`${cardClass} space-y-3`}>
      <h3 className="text-sm font-bold text-fg-strong">Who rides</h3>
      <fieldset className="space-y-3">
        <legend className="sr-only">Kinds of rider the company uses</legend>
        <label htmlFor={`${uid}-staff`} className="flex min-h-10 items-start gap-3">
          <input id={`${uid}-staff`} type="checkbox" className="mt-1 h-5 w-5" checked={staff} onChange={(e) => setStaff(e.target.checked)} />
          <span>
            <span className="block text-sm font-semibold text-fg-strong">{RIDER_KIND_WORDS.staff} ({settings.working.staff} riding)</span>
            <span className="block text-xs text-fg-muted">{RIDER_KIND_HELP.staff}</span>
          </span>
        </label>
        <label htmlFor={`${uid}-own`} className="flex min-h-10 items-start gap-3">
          <input id={`${uid}-own`} type="checkbox" className="mt-1 h-5 w-5" checked={own} onChange={(e) => setOwn(e.target.checked)} />
          <span>
            <span className="block text-sm font-semibold text-fg-strong">{RIDER_KIND_WORDS.separate} ({settings.working.separate} riding)</span>
            <span className="block text-xs text-fg-muted">{RIDER_KIND_HELP.separate}</span>
          </span>
        </label>
      </fieldset>
      <button type="button" className={primaryClass} disabled={busy || (staff === settings.allowStaff && own === settings.allowSeparate)} onClick={() => void save()}>
        Save
      </button>
    </section>
  );
}

function ProofPanel({ settings, onSaved, onError }: { settings: Settings; onSaved: (s: Settings) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [proof, setProof] = useState<ProofRule>(settings.proof);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const result = await attempt(setRiderProofAction({ proof, expectedVersion: settings.version }));
    setBusy(false);
    if (result.ok) onSaved(result.data);
    else onError(result.error);
  };
  return (
    <section aria-label="Proof at the door" className={`${cardClass} space-y-3`}>
      <h3 className="text-sm font-bold text-fg-strong">Proof at the door</h3>
      <p className="text-xs text-fg-muted">What a rider must show before a delivery can be marked delivered. A delivery that could not be made never needs proof.</p>
      <fieldset className="space-y-1">
        <legend className="sr-only">What a rider must show at the door</legend>
        {PROOF_RULES.map((rule) => (
          <label key={rule} htmlFor={`${uid}-${rule}`} className="flex min-h-10 items-start gap-3 rounded-lg px-1 py-1">
            <input id={`${uid}-${rule}`} type="radio" name={`${uid}-proof`} className="mt-1 h-5 w-5" checked={proof === rule} onChange={() => setProof(rule)} />
            <span>
              <span className="block text-sm font-semibold text-fg-strong">{PROOF_WORDS[rule]}</span>
              <span className="block text-xs text-fg-muted">{PROOF_HELP[rule]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <button type="button" className={primaryClass} disabled={busy || proof === settings.proof} onClick={() => void save()}>
        Save
      </button>
    </section>
  );
}

function AddPanel({ settings, onAdded, onError }: { settings: Settings; onAdded: (text: string) => void; onError: (text: string) => void }) {
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      {settings.allowStaff ? <AddStaff onAdded={onAdded} onError={onError} /> : null}
      {settings.allowSeparate ? <AddOwn onAdded={onAdded} onError={onError} /> : null}
    </div>
  );
}

function AddStaff({ onAdded, onError }: { onAdded: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [person, setPerson] = useState<Choice | null>(null);
  const [phone, setPhone] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [vehicleChoice, setVehicleChoice] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    const result = await attempt(addStaffRiderAction({ userId: person?.id ?? '', phone, vehicle, vehicleId: vehicleChoice?.id ?? '' }));
    setBusy(false);
    if (!result.ok) {
      onError(result.error);
      return;
    }
    onAdded(`${person?.label ?? 'They'} can now be given runs, and opens the rider app from the back office.`);
    setPerson(null);
    setPhone('');
    setVehicle('');
    setVehicleChoice(null);
  };
  return (
    <section aria-label="Add a member of staff" className={`${cardClass} space-y-3`}>
      <h3 className="text-sm font-bold text-fg-strong">Add a member of staff as a rider</h3>
      <ChoicePicker label="Staff member" source="delivery-staff" choice={person} onChoice={setPerson} placeholder="Search by name or email" />
      <Field id={`${uid}-phone`} label="Phone (optional, their own is used if left out)">
        <input id={`${uid}-phone`} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" maxLength={40} className={fieldClass} autoComplete="off" />
      </Field>
      <ChoicePicker label="Usual vehicle (optional)" source="delivery-vehicles" choice={vehicleChoice} onChoice={setVehicleChoice} placeholder="Choose a vehicle" clearable />
      <Field id={`${uid}-veh`} label="Or a vehicle typed in">
        <input id={`${uid}-veh`} value={vehicle} onChange={(e) => setVehicle(e.target.value)} maxLength={80} className={fieldClass} autoComplete="off" disabled={vehicleChoice !== null} />
      </Field>
      <button type="button" className={primaryClass} disabled={busy || person === null} onClick={() => void add()}>
        Make a rider
      </button>
    </section>
  );
}

function AddOwn({ onAdded, onError }: { onAdded: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '', vehicle: '' });
  const [vehicleChoice, setVehicleChoice] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });
  const add = async () => {
    setBusy(true);
    const result = await attempt(createOwnRiderAction({ ...form, vehicleId: vehicleChoice?.id ?? '' }));
    setBusy(false);
    if (!result.ok) {
      onError(result.error);
      return;
    }
    onAdded(`${form.name} has an account. Give them the email and the first password; they choose their own when they first sign in.`);
    setForm({ name: '', email: '', phone: '', password: '', vehicle: '' });
    setVehicleChoice(null);
  };
  return (
    <form
      aria-label="Make an account for a rider"
      className={`${cardClass} space-y-3`}
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <h3 className="text-sm font-bold text-fg-strong">Make an account for a rider</h3>
      <Field id={`${uid}-name`} label="Name">
        <input id={`${uid}-name`} value={form.name} onChange={set('name')} maxLength={120} className={fieldClass} autoComplete="off" />
      </Field>
      <Field id={`${uid}-email`} label="Email to sign in with">
        <input id={`${uid}-email`} type="email" value={form.email} onChange={set('email')} maxLength={200} className={fieldClass} autoComplete="off" />
      </Field>
      <Field id={`${uid}-phone`} label="Phone">
        <input id={`${uid}-phone`} value={form.phone} onChange={set('phone')} inputMode="tel" maxLength={40} className={fieldClass} autoComplete="off" />
      </Field>
      <Field id={`${uid}-pw`} label="First password" hint="They must choose their own the first time they sign in. At least 8 characters.">
        <input id={`${uid}-pw`} type="text" value={form.password} onChange={set('password')} maxLength={72} className={fieldClass} autoComplete="off" />
      </Field>
      <ChoicePicker label="Usual vehicle (optional)" source="delivery-vehicles" choice={vehicleChoice} onChoice={setVehicleChoice} placeholder="Choose a vehicle" clearable />
      <Field id={`${uid}-veh`} label="Or a vehicle typed in">
        <input id={`${uid}-veh`} value={form.vehicle} onChange={set('vehicle')} maxLength={80} className={fieldClass} autoComplete="off" disabled={vehicleChoice !== null} />
      </Field>
      <button type="submit" className={primaryClass} disabled={busy}>
        Create the account
      </button>
    </form>
  );
}

function RiderCard({ rider, onDone, onError }: { rider: RiderRow; onDone: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [asking, setAsking] = useState<RiderChange | 'password' | null>(null);
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [usual, setUsual] = useState<Choice | null>(rider.vehicleId === null ? null : { id: rider.vehicleId, label: rider.vehicle ?? '' });
  const [busy, setBusy] = useState(false);

  const close = () => {
    setAsking(null);
    setReason('');
    setPassword('');
  };
  const change = async (what: RiderChange) => {
    setBusy(true);
    const result = await attempt(changeRiderAction({ riderId: rider.id, change: what, reason, expectedVersion: rider.version }));
    setBusy(false);
    if (!result.ok) {
      onError(result.error);
      return;
    }
    close();
    onDone(`${rider.name}: ${result.data.statusWords.toLowerCase()}.`);
  };
  const saveVehicle = async () => {
    setBusy(true);
    const result = await attempt(updateRiderAction({ riderId: rider.id, vehicleId: usual?.id ?? '', vehicle: '', expectedVersion: rider.version }));
    setBusy(false);
    if (!result.ok) {
      onError(result.error);
      return;
    }
    onDone(usual === null ? `${rider.name} has no usual vehicle now.` : `${rider.name}'s usual vehicle is ${usual.label}. A run planned for them goes in it unless you choose another.`);
  };
  const reset = async () => {
    setBusy(true);
    const result = await attempt(resetRiderPasswordAction({ riderId: rider.id, password }));
    setBusy(false);
    if (!result.ok) {
      onError(result.error);
      return;
    }
    close();
    onDone(`${rider.name} has a new first password. They choose their own at the next sign-in.`);
  };

  return (
    <li className={`${cardClass} space-y-3`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-fg-strong">{rider.name}</p>
          <p className="break-words text-xs text-fg-muted">
            {rider.kindWords} · {rider.email}
            {rider.phone === null ? '' : ` · ${rider.phone}`}
            {rider.vehicle === null ? '' : ` · ${rider.vehicle}`}
            {rider.branchName === null ? '' : ` · ${rider.branchName}`}
          </p>
          {rider.statusReason === null ? null : <p className="text-xs text-fg-muted">Reason: {rider.statusReason}</p>}
          <p className="text-xs text-fg-muted">
            {rider.openRuns} {rider.openRuns === 1 ? 'run' : 'runs'} to do
          </p>
        </div>
        <Chip tone={TONE[rider.status]}>{rider.statusWords}</Chip>
      </div>
      {asking === null ? (
        <div className="flex flex-wrap gap-2">
          {rider.status === 'active' ? (
            <button type="button" className={buttonClass} onClick={() => setAsking('pause')}>
              Pause
            </button>
          ) : (
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void change('resume')}>
              Resume
            </button>
          )}
          {rider.status === 'ended' ? null : (
            <button type="button" className={buttonClass} onClick={() => setAsking('end')}>
              They have left
            </button>
          )}
          {rider.kind === 'separate' ? (
            <button type="button" className={buttonClass} onClick={() => setAsking('password')}>
              New first password
            </button>
          ) : null}
        </div>
      ) : null}
      {rider.status === 'ended' ? null : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 basis-64">
            <ChoicePicker label={`Usual vehicle of ${rider.name}`} source="delivery-vehicles" choice={usual} onChoice={setUsual} placeholder="Choose a vehicle" clearable />
          </div>
          <button type="button" className={buttonClass} disabled={busy || (usual?.id ?? null) === rider.vehicleId} onClick={() => void saveVehicle()}>
            Save the vehicle
          </button>
        </div>
      )}
      {rider.kind === 'separate' && rider.status !== 'ended' ? <RiderPinPanel riderId={rider.id} riderName={rider.name} initial={rider.pin} onError={onError} /> : null}
      {asking === 'password' ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void reset();
          }}
        >
          <div className="min-w-0 flex-1 basis-56">
            <Field id={`${uid}-pw`} label={`New first password for ${rider.name}`} hint="They must choose their own when they next sign in.">
              <input id={`${uid}-pw`} type="text" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={72} className={fieldClass} autoComplete="off" />
            </Field>
          </div>
          <button type="submit" className={primaryClass} disabled={busy}>
            Set it
          </button>
          <button type="button" className={buttonClass} onClick={close}>
            Keep the old one
          </button>
        </form>
      ) : null}
      {asking !== null && asking !== 'password' ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void change(asking);
          }}
        >
          <div className="min-w-0 flex-1 basis-56">
            <Field id={`${uid}-why`} label={asking === 'pause' ? 'Why are they paused?' : 'Why have they left?'}>
              <input id={`${uid}-why`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className={fieldClass} autoComplete="off" />
            </Field>
          </div>
          <button type="submit" className={primaryClass} disabled={busy || reason.trim() === ''}>
            {asking === 'pause' ? 'Pause them' : 'Yes, they have left'}
          </button>
          <button type="button" className={buttonClass} onClick={close}>
            Keep them riding
          </button>
        </form>
      ) : null}
    </li>
  );
}
