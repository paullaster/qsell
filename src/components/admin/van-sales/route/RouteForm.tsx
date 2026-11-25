'use client';

import { useId, useState } from 'react';
import { createRouteAction, updateRouteAction, type RouteScreen } from '@/server/domains/van-sales/actions';
import type { RouteView } from '@/server/domains/van-sales/routes';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Field, attempt, buttonClass, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';
import { NAME_LIMIT } from '@/lib/van-sales/people';
import { ROUTE_MODES, ROUTE_MODE_WORDS, routeModeProblem, type RouteMode } from '@/lib/van-sales/settings';

const MODE_HELP: Record<RouteMode, string> = {
  van_sell: 'The rep sells from the van and hands the goods over on the spot.',
  pre_sell: 'The rep takes orders; the goods follow later. No van is needed.',
  both: 'The rep sells from the van and also takes orders for later.',
};

/** Adds a route, or changes one. The same words and the same rules in both places. */
export function RouteForm({ route, modes, onSaved, onCancel }: { route?: RouteView; modes: { vanSell: boolean; preSell: boolean }; onSaved: (saved: RouteView | RouteScreen) => void; onCancel: () => void }) {
  const uid = useId();
  const [code, setCode] = useState(route?.code ?? '');
  const [name, setName] = useState(route?.name ?? '');
  const [branch, setBranch] = useState<Choice | null>(route === undefined ? null : { id: route.branchId, label: route.branchName });
  const [mode, setMode] = useState<RouteMode>(route?.mode ?? (modes.vanSell ? 'van_sell' : 'pre_sell'));
  const [van, setVan] = useState<Choice | null>(route?.defaultVanId === null || route === undefined ? null : { id: route.defaultVanId, label: route.defaultVanName ?? 'Van' });
  const [rep, setRep] = useState<Choice | null>(route?.defaultRepId === null || route === undefined ? null : { id: route.defaultRepId, label: route.defaultRepName ?? 'Sales rep' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submitWords = route === undefined ? 'Add the route' : 'Save';
  const noVan = mode === 'pre_sell';
  const save = async () => {
    setBusy(true);
    setProblem(null);
    const body = { code, name, branchId: branch?.id ?? '', mode, defaultVanId: noVan ? null : (van?.id ?? null), defaultRepId: rep?.id ?? null };
    if (route === undefined) {
      const r = await attempt(createRouteAction(body));
      setBusy(false);
      if (r.ok) onSaved(r.data);
      else setProblem(r.error);
      return;
    }
    const r = await attempt(updateRouteAction({ ...body, id: route.id, expectedVersion: route.version }));
    setBusy(false);
    if (r.ok) onSaved(r.data);
    else setProblem(r.error);
  };
  return (
    <form aria-label={route === undefined ? 'New route' : `Change ${route.name}`} className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Field id={`${uid}-code`} label="Route code" hint="Short, for example KIAMBU-MON">
        <input id={`${uid}-code`} className={fieldClass} value={code} onChange={(e) => setCode(e.target.value)} maxLength={20} autoComplete="off" autoFocus />
      </Field>
      <Field id={`${uid}-name`} label="Route name" hint={`${String(NAME_LIMIT.min)} to ${String(NAME_LIMIT.max)} characters, for example Kiambu Monday`}>
        <input id={`${uid}-name`} className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={NAME_LIMIT.max} autoComplete="off" />
      </Field>
      {route === undefined ? (
        <ChoicePicker label="Branch the route starts from" source="van-branches" choice={branch} onChoice={(b) => { setBranch(b); setVan(null); }} placeholder="Choose the branch…" required />
      ) : (
        <Field id={`${uid}-branch`} label="Branch" hint="A route stays in its branch."><input id={`${uid}-branch`} className={fieldClass} value={route.branchName} readOnly /></Field>
      )}
      <fieldset className="space-y-1 sm:col-span-2">
        <legend className="mb-1 text-sm font-semibold text-fg-strong">What the route is for</legend>
        {ROUTE_MODES.map((m) => {
          const off = routeModeProblem(modes, m);
          return (
            <label key={m} className={`flex min-h-11 items-start gap-3 rounded-lg border border-line px-3 py-2 text-sm has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-500/5 ${off === null ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
              <input type="radio" name={`${uid}-mode`} className="mt-0.5 size-4" checked={mode === m} disabled={off !== null} onChange={() => { setMode(m); if (m === 'pre_sell') setVan(null); }} />
              <span>
                <span className="block font-semibold text-fg-strong">{ROUTE_MODE_WORDS[m]}</span>
                <span className="block text-fg-muted">{off ?? MODE_HELP[m]}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      {noVan ? (
        <p className="self-end text-sm text-fg-muted">A route that only takes orders has no usual van.</p>
      ) : (
        <ChoicePicker key={branch?.id ?? 'none'} label="Usual van (optional)" source="van-vans" filters={branch === null ? undefined : { branch: branch.id }} choice={van} onChoice={setVan} placeholder="Choose a van of this branch…" clearable />
      )}
      <ChoicePicker label="Usual sales rep (optional)" source="van-reps" choice={rep} onChoice={setRep} placeholder="Choose a rep who is selling…" clearable />
      {problem === null ? null : <p role="alert" className="text-sm text-red-700 sm:col-span-2">{problem}</p>}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button type="submit" className={primaryClass} disabled={busy}>{busy ? 'Saving…' : submitWords}</button>
        <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
