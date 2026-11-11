'use client';

import { use, useId, useState } from 'react';
import { createVehicleAction, setVehicleActiveAction, updateVehicleAction, vehiclesScreenAction } from '@/server/domains/delivery/vehicle-actions';
import type { VehicleView } from '@/server/domains/delivery/vehicles';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { kilos } from '@/lib/delivery-vehicle';

type Loaded = Awaited<ReturnType<typeof vehiclesScreenAction>>;

export function VehiclesClient({ firstPromise }: { firstPromise: ReturnType<typeof vehiclesScreenAction> }) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Body initial={res.data} /> : <LoadFailed error={res.error} />;
}

const limitsWords = (v: VehicleView): string => {
  const parts = [v.maxWeightKg === null ? null : `up to ${kilos(v.maxWeightKg)}`, v.maxStops === null ? null : `${String(v.maxStops)} ${v.maxStops === 1 ? 'stop' : 'stops'} a run`].filter((p): p is string => p !== null);
  return parts.length === 0 ? 'No limit set' : parts.join(' · ');
};

function Body({ initial }: { initial: VehicleView[] }) {
  const [list, setList] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [fresh, setFresh] = useState(0);
  const reload = async (text: string) => {
    const r = await attempt(vehiclesScreenAction());
    if (r.ok) {
      setList(r.data);
      setNotice({ kind: 'ok', text });
    } else setNotice({ kind: 'error', text: r.error });
  };
  const fail = (text: string) => setNotice({ kind: 'error', text });
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Vehicles" intro="The vehicles your riders go out in, and what a run may carry in each: the most weight and the most stops. A run in a vehicle cannot take a delivery that would go over its limits. Leave a limit empty for none; goods with no weight count as nothing." />
      <Message notice={notice} />
      <VehicleForm
        key={`new-${String(fresh)}`}
        onSaved={(t) => {
          setFresh((n) => n + 1);
          void reload(t);
        }}
        onError={fail}
      />
      <section aria-label="Vehicles" className="space-y-3">
        <h3 className="text-sm font-bold text-fg-strong">Your vehicles</h3>
        {list.length === 0 ? (
          <p role="status" className="rounded-xl border border-line bg-surface-raised p-8 text-center text-sm text-fg-muted">
            No vehicle yet. Add one above. A run can still be given a vehicle typed in, which limits nothing.
          </p>
        ) : null}
        <ul className="space-y-3" aria-label="Vehicle list">
          {list.map((v) => (
            <VehicleRow key={`${v.id}-${String(v.version)}`} vehicle={v} onSaved={(t) => void reload(t)} onError={fail} />
          ))}
        </ul>
      </section>
    </div>
  );
}

function VehicleForm({ vehicle, onSaved, onError }: { vehicle?: VehicleView; onSaved: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [name, setName] = useState(vehicle?.name ?? '');
  const [weight, setWeight] = useState(vehicle?.maxWeightKg === null || vehicle === undefined ? '' : String(vehicle.maxWeightKg));
  const [stops, setStops] = useState(vehicle?.maxStops === null || vehicle === undefined ? '' : String(vehicle.maxStops));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const input = { name, maxWeightKg: weight, maxStops: stops };
    const r = await attempt(vehicle === undefined ? createVehicleAction(input) : updateVehicleAction({ ...input, id: vehicle.id, expectedVersion: vehicle.version }));
    setBusy(false);
    if (r.ok) onSaved(vehicle === undefined ? 'The vehicle is added.' : 'Saved. The limits apply to the stops put on a run from now on.');
    else onError(r.error);
  };
  return (
    <form
      aria-label={vehicle === undefined ? 'Add a vehicle' : `Change ${vehicle.name}`}
      className={`${cardClass} grid grid-cols-1 gap-3 sm:grid-cols-3`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field id={`${uid}-n`} label="Name or number plate">
        <input id={`${uid}-n`} className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" required />
      </Field>
      <Field id={`${uid}-w`} label="Most weight it carries (kg)" hint="Empty for no limit">
        <input id={`${uid}-w`} className={fieldClass} inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} autoComplete="off" />
      </Field>
      <Field id={`${uid}-s`} label="Most stops on a run" hint="Empty for no limit">
        <input id={`${uid}-s`} className={fieldClass} inputMode="numeric" value={stops} onChange={(e) => setStops(e.target.value)} autoComplete="off" />
      </Field>
      <div className="sm:col-span-3">
        <button type="submit" className={primaryClass} disabled={busy}>
          {vehicle === undefined ? 'Add the vehicle' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function VehicleRow({ vehicle, onSaved, onError }: { vehicle: VehicleView; onSaved: (text: string) => void; onError: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    const r = await attempt(setVehicleActiveAction({ id: vehicle.id, isActive: !vehicle.isActive, expectedVersion: vehicle.version }));
    setBusy(false);
    if (r.ok) onSaved(vehicle.isActive ? `${vehicle.name} is stopped. Runs already in it carry on; no new run can be given it.` : `${vehicle.name} is in use again.`);
    else onError(r.error);
  };
  return (
    <li className={`${cardClass} space-y-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 basis-48 text-sm font-semibold text-fg-strong">{vehicle.name}</p>
        <Chip tone={vehicle.isActive ? 'green' : 'gray'}>{vehicle.isActive ? 'In use' : 'Stopped'}</Chip>
      </div>
      <p className="text-xs text-fg-muted">
        {limitsWords(vehicle)}
        {vehicle.runsInUse > 0 ? ` · ${String(vehicle.runsInUse)} ${vehicle.runsInUse === 1 ? 'run' : 'runs'} planned or out now` : ''}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
          {editing ? 'Close' : 'Change the limits'}
        </button>
        <button type="button" className={buttonClass} onClick={() => void toggle()} disabled={busy}>
          {vehicle.isActive ? 'Stop using' : 'Use again'}
        </button>
      </div>
      {editing ? <VehicleForm vehicle={vehicle} onSaved={onSaved} onError={onError} /> : null}
    </li>
  );
}
