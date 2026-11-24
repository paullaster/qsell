'use client';

import { use, useId, useState, type ReactNode } from 'react';
import { saveVanSalesSettingsAction, type vanSalesSettingsScreenAction } from '@/server/domains/van-sales/settings-actions';
import type { VanSalesScreen } from '@/server/domains/van-sales/settings-service';
import { OFF_ROUTE_RULES, OFF_ROUTE_WORDS, POSITION_RULES, POSITION_WORDS, SHORTAGE_RULES, SHORTAGE_WORDS, readSettings, type VanSalesSettings } from '@/lib/van-sales/settings';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { ReasonField, type ReasonValue } from '../numbering/ReasonField';

type Loaded = Awaited<ReturnType<typeof vanSalesSettingsScreenAction>>;

export function VanSalesSettingsClient({ firstPromise }: { firstPromise: ReturnType<typeof vanSalesSettingsScreenAction> }) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Body initial={res.data} /> : <LoadFailed error={res.error} />;
}

/** Radio choices drawn as large, tappable rows (never a drop-down: there are only two or three). */
function Choice<T extends string>({ legend, name, value, options, words, onChange }: { legend: string; name: string; value: T; options: readonly T[]; words: Record<T, string>; onChange: (next: T) => void }) {
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-sm font-semibold text-fg-strong">{legend}</legend>
      {options.map((o) => (
        <label key={o} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line px-3 py-2 text-sm has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-500/5">
          <input type="radio" name={name} className="mt-0.5 size-4" checked={value === o} onChange={() => onChange(o)} />
          <span>{words[o]}</span>
        </label>
      ))}
    </fieldset>
  );
}

function Switch({ label, help, checked, onChange }: { label: string; help: ReactNode; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className="flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border border-line p-3 has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-500/5">
      <input type="checkbox" className="mt-1 size-5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="space-y-0.5 text-sm">
        <span className="block font-semibold text-fg-strong">{label}</span>
        <span className="block text-fg-muted">{help}</span>
      </span>
    </label>
  );
}

function Body({ initial }: { initial: VanSalesScreen }) {
  const uid = useId();
  const [data, setData] = useState(initial);
  const [draft, setDraft] = useState<VanSalesSettings>(initial.settings);
  const [limit, setLimit] = useState(String(initial.settings.shortageApprovalAbove));
  const [near, setNear] = useState(String(initial.settings.nearMetres));
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const set = <K extends keyof VanSalesSettings>(key: K, value: VanSalesSettings[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const typed: VanSalesSettings = { ...draft, shortageApprovalAbove: Number(limit), nearMetres: Number(near) };
  const problem = readSettings(typed);
  const changed = JSON.stringify(typed) !== JSON.stringify(data.settings);
  const reset = () => { setDraft(data.settings); setLimit(String(data.settings.shortageApprovalAbove)); setNear(String(data.settings.nearMetres)); };
  const save = async () => {
    setBusy(true);
    setNotice(null);
    const r = await attempt(saveVanSalesSettingsAction(typed, data.version, reason));
    setBusy(false);
    if (r.ok) {
      setData(r.data);
      setDraft(r.data.settings);
      setLimit(String(r.data.settings.shortageApprovalAbove));
      setNear(String(r.data.settings.nearMetres));
      setReason({ code: '', text: '' });
      setNotice({ kind: 'ok', text: 'Saved. Van sales now follows these rules.' });
    } else setNotice({ kind: 'error', text: r.error });
  };
  const on = data.settings.vanSell || data.settings.preSell;
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Van sales" intro="Sell from a loaded van, take orders on a route, or both. Switch on what your company does. Reps cannot sell until one of the two is on." />
      <Message notice={notice} />
      <form aria-label="Van sales" className={`${cardClass} space-y-5`} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-fg-muted">{data.updatedBy === null ? 'Never changed: both are off by default.' : `Last changed by ${data.updatedBy}${data.updatedAt === null ? '' : ` on ${new Date(data.updatedAt).toLocaleString()}`}.`}</p>
          <div className="flex gap-2">
            <Chip tone={data.settings.vanSell ? 'green' : 'gray'}>Van sell {data.settings.vanSell ? 'on' : 'off'}</Chip>
            <Chip tone={data.settings.preSell ? 'green' : 'gray'}>Pre-sell {data.settings.preSell ? 'on' : 'off'}</Chip>
          </div>
        </div>

        <div className="space-y-2">
          <h2 className="text-base font-bold text-fg-strong">What your reps do</h2>
          <Switch label="Van sell" help="The rep drives a loaded van, sells, and hands the goods over on the spot. Stock and cash are signed out in the morning and counted back at the end of the day." checked={draft.vanSell} onChange={(v) => set('vanSell', v)} />
          <Switch label="Pre-sell" help="The rep takes an order on a visit and the goods follow later, from a delivery run or on the customer's next route day. No van or cash is needed." checked={draft.preSell} onChange={(v) => set('preSell', v)} />
          <p className="text-sm text-fg-muted">Use one or both. A route can be van sell, pre-sell or both, and a rep may do either on the same day.</p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Choice legend="Customers not on the route" name={`${uid}-off`} value={draft.offRoute} options={OFF_ROUTE_RULES} words={OFF_ROUTE_WORDS} onChange={(v) => set('offRoute', v)} />
          <Choice legend="Stock that is missing from a van" name={`${uid}-short`} value={draft.shortage} options={SHORTAGE_RULES} words={SHORTAGE_WORDS} onChange={(v) => set('shortage', v)} />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${uid}-limit`} label="A second person must decide a shortage worth more than (KES, at cost)">
            <input id={`${uid}-limit`} type="number" min={0} step="1" inputMode="decimal" className={fieldClass} value={limit} onChange={(e) => setLimit(e.target.value)} />
          </Field>
          <div className="self-end text-sm text-fg-muted">Put 0 to have every shortage decided by a second person.</div>
        </div>

        <Switch label="Stock may stay on the van overnight" help="Off: every van is unloaded and counted at the end of each day. On: the rest stays on the van, signed for by the rep, and is counted when the day closes." checked={draft.overnightStock} onChange={(v) => set('overnightStock', v)} />

        <div className="space-y-3">
          <Choice legend="Where the rep is when visiting" name={`${uid}-pos`} value={draft.position} options={POSITION_RULES} words={POSITION_WORDS} onChange={(v) => set('position', v)} />
          {draft.position === 'require' ? (
            <Field id={`${uid}-near`} label="How near counts as at the customer (metres)">
              <input id={`${uid}-near`} type="number" min={20} max={5000} step="1" inputMode="numeric" className={fieldClass} value={near} onChange={(e) => setNear(e.target.value)} />
            </Field>
          ) : null}
        </div>

        {changed && !problem.ok ? <p role="alert" className="text-sm text-red-700">{problem.error}</p> : null}
        <ReasonField value={reason} onChange={setReason} source="van-sales-reasons" />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={primaryClass} disabled={busy || !changed || !problem.ok || reason.code === ''}>{busy ? 'Saving…' : 'Save'}</button>
          {changed ? <button type="button" className={buttonClass} onClick={reset} disabled={busy}>Undo</button> : null}
        </div>
        {on ? null : <p className="text-sm text-fg-muted">Both modes are off, so reps cannot sell yet. You can still set up vans and reps under Sales › Van sales.</p>}
      </form>
    </div>
  );
}
