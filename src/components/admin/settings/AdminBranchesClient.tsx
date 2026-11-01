'use client';

import { use, useId, useState } from 'react';
import { branchesPageAction, clearBranchPinAction, createBranchAction, setBranchPinAction, updateBranchAction, type BranchView } from '@/server/domains/branches/actions';
import { usePagedList } from '@/components/ui/usePagedList';
import { attempt, buttonClass, Chip, Field, fieldClass, LoadFailed, Message, PageHeader, primaryClass, cardClass, type Notice } from '@/components/ui/screen-kit';
import { branchPayload, emptyBranchForm, pinFormFor, type BranchForm, type PinForm } from '@/lib/branch-forms';
import { readGeoPoint } from '@/lib/geo';

type FirstPage = Awaited<ReturnType<typeof branchesPageAction>>;

interface Props {
  firstPage: ReturnType<typeof branchesPageAction>;
  canManage: Promise<boolean>;
  /** Inside a dialog that already shows the title. */
  embedded?: boolean;
}

export function AdminBranchesClient({ firstPage, canManage, embedded = false }: Props) {
  const first = use(firstPage);
  const may = use(canManage);
  return first.ok ? <BranchesView first={first} may={may} embedded={embedded} /> : <LoadFailed error={first.error} />;
}

function BranchesView({ first, may, embedded }: { first: FirstPage; may: boolean; embedded: boolean }) {
  const uid = useId();
  const [query, setQuery] = useState('');
  const [form, setForm] = useState<BranchForm>(emptyBranchForm);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const list = usePagedList<BranchView, { query: string }>({
    load: (filters, cursor) => branchesPageAction({ query: filters.query, cursor }),
    filters: { query: query.trim() },
    initialPage: first,
  });

  const finish = (ok: boolean, text: string) => {
    setBusy(false);
    setNotice({ kind: ok ? 'ok' : 'error', text });
    if (ok) list.reload();
  };
  const create = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const checked = branchPayload(form);
    if (!checked.ok) {
      setNotice({ kind: 'error', text: checked.error });
      return;
    }
    setBusy(true);
    const res = await attempt(createBranchAction(checked.payload));
    if (res.ok) setForm(emptyBranchForm());
    finish(res.ok, res.ok ? `${checked.payload.name} added.` : res.error);
  };
  const change = async (b: BranchView, patch: { actsIndependently?: boolean; isDefault?: boolean }, done: string) => {
    setBusy(true);
    const res = await attempt(updateBranchAction(b.id, patch));
    finish(res.ok, res.ok ? done : res.error);
  };

  const setPin = async (b: BranchView, form: PinForm) => {
    const point = readGeoPoint(form.latitude, form.longitude);
    if (!point.ok) {
      setNotice({ kind: 'error', text: point.error });
      return false;
    }
    setBusy(true);
    const res = await attempt(setBranchPinAction(b.id, { latitude: point.point.latitude, longitude: point.point.longitude, label: form.label }));
    finish(res.ok, res.ok ? `${b.name} is now on the map.` : res.error);
    return res.ok;
  };
  const clearPin = async (b: BranchView) => {
    setBusy(true);
    const res = await attempt(clearBranchPinAction(b.id));
    finish(res.ok, res.ok ? `${b.name} is no longer on the map.` : res.error);
  };

  return (
    <div className="max-w-5xl space-y-5">
      {embedded ? (
        <p className="max-w-2xl text-sm text-fg-muted">Each branch can hold its own payment credentials, KRA PIN, and banking details when marked as independent.</p>
      ) : (
        <PageHeader title="Branches" intro="Each branch can hold its own payment credentials, KRA PIN, and banking details when marked as independent." />
      )}
      <Message notice={notice} />

      <div className="max-w-sm">
        <label htmlFor={`${uid}-search`} className="sr-only">
          Search branches
        </label>
        <input id={`${uid}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by code or name" className={fieldClass} autoComplete="off" />
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
          Loading…
        </p>
      ) : null}

      <ul className="space-y-2" aria-label="Branches">
        {list.rows.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-raised p-3 sm:p-4">
            <p className="min-w-0 text-sm font-semibold text-fg-strong">
              <span className="font-mono font-normal text-fg">{b.code}</span> · {b.name} {b.isDefault ? <Chip tone="amber">Default</Chip> : null} {b.isActive ? null : <Chip tone="gray">Closed</Chip>}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex min-h-10 items-center gap-2 text-xs text-fg">
                <input
                  type="checkbox"
                  className="h-5 w-5 rounded border-line-strong"
                  checked={b.actsIndependently}
                  disabled={!may || busy}
                  onChange={(e) => void change(b, { actsIndependently: e.target.checked }, `${b.name} updated.`)}
                  aria-label={`${b.name} acts independently`}
                />
                Independent
              </label>
              {may && !b.isDefault ? (
                <button type="button" className={buttonClass} disabled={busy} onClick={() => void change(b, { isDefault: true }, `${b.name} is now the default.`)} aria-label={`Make ${b.name} the default`}>
                  Make default
                </button>
              ) : null}
            </div>
            <BranchPin branch={b} may={may} busy={busy} onSave={setPin} onClear={clearPin} />
          </li>
        ))}
      </ul>
      {list.phase === 'idle' && list.rows.length === 0 ? <p className="text-sm text-fg-muted">{query.trim() === '' ? 'No branches yet.' : `No branches match “${query.trim()}”.`}</p> : null}
      {list.cursor === null ? null : (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more branches'}
        </button>
      )}

      {may ? (
        <form onSubmit={(e) => void create(e)} className={`${cardClass} space-y-3`} aria-label="Add branch">
          <h3 className="text-sm font-bold text-fg-strong">Add branch</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id={`${uid}-code`} label="Code">
              <input id={`${uid}-code`} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="e.g. NBO" className={`${fieldClass} font-mono uppercase`} required />
            </Field>
            <Field id={`${uid}-name`} label="Name">
              <input id={`${uid}-name`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Nairobi Branch" className={fieldClass} required />
            </Field>
          </div>
          <label className="flex min-h-10 items-center gap-2 text-xs text-fg">
            <input type="checkbox" checked={form.actsIndependently} onChange={(e) => setForm({ ...form, actsIndependently: e.target.checked })} className="h-5 w-5 rounded border-line-strong" />
            Acts as independent unit (own KRA / paybill / bank)
          </label>
          <button type="submit" disabled={busy} className={primaryClass}>
            {busy ? 'Creating…' : 'Create branch'}
          </button>
        </form>
      ) : null}
    </div>
  );
}

/** Where a branch is. Delivery works out the nearest branch, and how far it is from the customer, from this pin. */
function BranchPin({ branch, may, busy, onSave, onClear }: { branch: BranchView; may: boolean; busy: boolean; onSave: (b: BranchView, form: PinForm) => Promise<boolean>; onClear: (b: BranchView) => Promise<void> }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PinForm>(() => pinFormFor(branch.pin));
  const [locating, setLocating] = useState<string | null>(null);

  const useMyLocation = () => {
    if (!('geolocation' in navigator)) {
      setLocating('This device cannot share its location. Type the latitude and longitude instead.');
      return;
    }
    setLocating('Finding your location…');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setForm((f) => ({ ...f, latitude: position.coords.latitude.toFixed(6), longitude: position.coords.longitude.toFixed(6) }));
        setLocating(`Found it, accurate to about ${String(Math.round(position.coords.accuracy))} metres. Check it, then save.`);
      },
      () => setLocating('Could not get your location. Allow location for this site, or type the latitude and longitude.'),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  };

  return (
    <div className="w-full space-y-2 border-t border-line pt-2 text-xs text-fg">
      <div className="flex flex-wrap items-center gap-2">
        {branch.pin === null ? (
          <Chip tone="amber">No pin yet</Chip>
        ) : (
          <span>
            On the map at <span className="font-mono">{branch.pin.latitude.toFixed(5)}, {branch.pin.longitude.toFixed(5)}</span>
            {branch.pin.label === null ? '' : ` (${branch.pin.label})`}
          </span>
        )}
        {may ? (
          <button type="button" className={buttonClass} aria-expanded={open} aria-controls={`${uid}-pin`} onClick={() => setOpen((o) => !o)} aria-label={`${branch.pin === null ? 'Set' : 'Change'} the map pin for ${branch.name}`}>
            {branch.pin === null ? 'Set pin' : 'Change pin'}
          </button>
        ) : null}
      </div>
      {branch.pin === null ? <p className="text-fg-muted">Without a pin this branch is left out when the nearest branch is chosen for a delivery.</p> : null}
      {open ? (
        <form
          id={`${uid}-pin`}
          aria-label={`Map pin for ${branch.name}`}
          className="grid grid-cols-1 gap-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            void onSave(branch, form).then((ok) => {
              if (ok) setOpen(false);
            });
          }}
        >
          <Field id={`${uid}-lat`} label="Latitude">
            <input id={`${uid}-lat`} inputMode="decimal" value={form.latitude} onChange={(e) => setForm({ ...form, latitude: e.target.value })} placeholder="-1.286389" className={`${fieldClass} font-mono`} autoComplete="off" required />
          </Field>
          <Field id={`${uid}-lng`} label="Longitude">
            <input id={`${uid}-lng`} inputMode="decimal" value={form.longitude} onChange={(e) => setForm({ ...form, longitude: e.target.value })} placeholder="36.817223" className={`${fieldClass} font-mono`} autoComplete="off" required />
          </Field>
          <Field id={`${uid}-label`} label="What to call the place (optional)">
            <input id={`${uid}-label`} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="e.g. Shop front on Moi Avenue" maxLength={120} className={fieldClass} />
          </Field>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
            <button type="button" className={buttonClass} onClick={useMyLocation}>
              Use my current location
            </button>
            <button type="submit" disabled={busy} className={primaryClass}>
              {busy ? 'Saving…' : 'Save pin'}
            </button>
            {branch.pin === null ? null : (
              <button type="button" className={buttonClass} disabled={busy} onClick={() => void onClear(branch).then(() => setOpen(false))}>
                Remove pin
              </button>
            )}
          </div>
          {locating === null ? null : (
            <p role="status" aria-live="polite" className="text-fg-muted sm:col-span-3">
              {locating}
            </p>
          )}
        </form>
      ) : null}
    </div>
  );
}
