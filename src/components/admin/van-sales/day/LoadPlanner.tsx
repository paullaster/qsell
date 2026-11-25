'use client';

import { useId, useRef, useState } from 'react';
import { createLoadAction, loadSuggestAction, type DayScreen } from '@/server/domains/van-sales/actions';
import type { Suggestion } from '@/server/domains/van-sales/loads';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Field, attempt, buttonClass, cardClass, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';
import { mergeSuggestion, plannerRows, type PlannerRow } from '@/lib/van-sales/load';
import type { DayCall } from './call';

/**
 * Makes up a load: what the route's usual stock suggests, as far as the warehouse can give it, which the planner can change and add to
 * before it is asked for. The warehouse can be changed, and the suggestion is worked out again from it.
 */
export function LoadPlanner({ screen, suggestion, run }: { screen: DayScreen; suggestion: Suggestion; run: DayCall }) {
  const uid = useId();
  const day = screen.detail.day;
  const kind = day.status === 'out' ? 'top_up' : 'load';
  const [source, setSource] = useState<Choice | null>(suggestion.source === null ? null : { id: suggestion.source.id, label: suggestion.source.name });
  const [rows, setRows] = useState<PlannerRow[]>(() => plannerRows(suggestion.rows));
  const [note, setNote] = useState<string | null>(suggestion.note);
  const [product, setProduct] = useState<Choice | null>(null);
  const [amount, setAmount] = useState('');
  const [fresh, setFresh] = useState(0);
  const removed = useRef(new Set<string>());
  const asked = useRef(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const title = kind === 'load' ? 'Make up the load' : 'Make up a top-up';

  const changeSource = async (next: Choice | null) => {
    setSource(next);
    if (next === null) return;
    const turn = ++asked.current;
    const r = await attempt(loadSuggestAction({ dayId: day.id, fromLocationId: next.id }));
    // An answer for a warehouse that is no longer the chosen one is ignored.
    if (turn !== asked.current) return;
    if (r.ok) { setRows((cur) => mergeSuggestion(plannerRows(r.data.rows), cur, removed.current)); setNote(r.data.note); setProblem(null); } else setProblem(r.error);
  };
  const addProblem = (): string | null => {
    if (product === null) return 'Choose a product from the list.';
    if (rows.some((x) => x.productId === product.id)) return 'That product is on the list. Change its quantity instead.';
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? null : 'Give a quantity of more than nothing.';
  };
  const add = () => {
    const why = addProblem();
    setProblem(why);
    if (why !== null || product === null) return;
    removed.current.delete(product.id);
    setRows((cur) => [...cur, { productId: product.id, name: product.label, par: null, onVan: null, available: null, quantity: String(Number(amount)), short: 0, edited: true }]);
    setProduct(null);
    setAmount('');
    setFresh((f) => f + 1);
  };
  const create = async () => {
    setBusy(true);
    setProblem(null);
    const lines = rows.map((r) => ({ productId: r.productId, quantity: Number(r.quantity) })).filter((l) => Number.isFinite(l.quantity) && l.quantity > 0);
    const answer = await run(createLoadAction({ dayId: day.id, kind, fromLocationId: source?.id, lines }), `${kind === 'load' ? 'The load' : 'The top-up'} is made up and asked for. Send it when the stock is ready to leave.`);
    setBusy(false);
    if (answer !== null) setProblem(answer);
  };
  return (
    <section className={`${cardClass} space-y-3`} aria-label={title}>
      <div>
        <h2 className="text-base font-bold text-fg-strong">{title}</h2>
        <p className="text-sm text-fg-muted">What the route&apos;s usual stock suggests, less what is on the van, as far as the warehouse has it. Change the quantities or add a product before you ask for it.</p>
      </div>
      <ChoicePicker label="Load from" source="van-load-sources" choice={source} onChoice={(c) => void changeSource(c)} placeholder="Choose a warehouse or store…" required />
      {note === null ? null : <p role="status" className="text-sm text-fg-muted">{note}</p>}
      {rows.length === 0 ? null : (
        <ul className="space-y-2" aria-label="To load">
          {rows.map((r) => (
            <li key={r.productId} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3">
              <div className="min-w-0 flex-1 basis-48">
                <p className="text-sm font-semibold text-fg-strong">{r.name}</p>
                <p className="text-xs text-fg-muted">
                  {r.par === null ? 'Added by hand' : `Usual ${String(r.par)} · on the van ${String(r.onVan ?? 0)}`}
                  {r.available === null ? '' : ` · warehouse has ${String(r.available)}`}
                </p>
                {r.short > 0 ? <p className="text-xs text-amber-700">{String(r.short)} short: the warehouse cannot give it all.</p> : null}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <span className="sr-only">Load of {r.name}</span>
                <input className={`${fieldClass} w-28`} inputMode="decimal" value={r.quantity} onChange={(e) => setRows((cur) => cur.map((x) => (x.productId === r.productId ? { ...x, quantity: e.target.value, edited: true } : x)))} autoComplete="off" />
              </label>
              <button type="button" className={buttonClass} onClick={() => { removed.current.add(r.productId); setRows((cur) => cur.filter((x) => x.productId !== r.productId)); }} aria-label={`Take ${r.name} off the load`}>Take off</button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto] sm:items-end">
        <ChoicePicker key={fresh} label="Add a product" source="van-plan-products" choice={product} onChoice={setProduct} placeholder="Search products by name or code…" />
        <Field id={`${uid}-qty`} label="Quantity"><input id={`${uid}-qty`} className={fieldClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoComplete="off" /></Field>
        <button type="button" className={buttonClass} onClick={add}>Add to the load</button>
      </div>
      {problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}
      <button type="button" className={primaryClass} disabled={busy || rows.length === 0 || source === null} onClick={() => void create()}>{busy ? 'Making it up…' : `Ask for the ${kind === 'load' ? 'load' : 'top-up'}`}</button>
    </section>
  );
}
