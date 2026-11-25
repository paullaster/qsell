'use client';

import { useId, useState } from 'react';
import { setParAction, type RouteScreen } from '@/server/domains/van-sales/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Field, buttonClass, cardClass, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';
import type { RouteCall } from './call';

interface Line {
  productId: string;
  name: string;
  /** Known once the line is saved. */
  unitName: string | null;
  decimals: number;
  quantity: string;
}

/**
 * What the van should start the day with: one quantity for each product. It is edited as a list on the screen and saved as a whole, so
 * what is saved is exactly what was seen. The load planner later tops the van up to these levels.
 */
export function ParPanel({ screen, run }: { screen: RouteScreen; run: RouteCall }) {
  // A fresh start whenever the route has been saved by anyone: the list is read from what is saved.
  return <ParEditor key={screen.route.version} screen={screen} run={run} />;
}

function ParEditor({ screen, run }: { screen: RouteScreen; run: RouteCall }) {
  const uid = useId();
  const saved: Line[] = screen.par.map((p) => ({ productId: p.productId, name: p.productName, unitName: p.unitName, decimals: p.decimals, quantity: String(p.quantity) }));
  const [lines, setLines] = useState<Line[]>(saved);
  const [product, setProduct] = useState<Choice | null>(null);
  const [amount, setAmount] = useState('');
  const [fresh, setFresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const may = screen.canManage && screen.route.status === 'active';
  const changed = JSON.stringify(lines.map((l) => [l.productId, Number(l.quantity)])) !== JSON.stringify(saved.map((l) => [l.productId, Number(l.quantity)]));
  /** Why the product typed cannot be put on the list, or null when it can. */
  const addProblem = (): string | null => {
    if (product === null) return 'Choose a product from the list.';
    if (lines.some((l) => l.productId === product.id)) return 'That product is on the list. Change its quantity instead.';
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? null : 'Give a quantity of more than nothing.';
  };
  const add = () => {
    const why = addProblem();
    setProblem(why);
    if (why !== null || product === null) return;
    setLines((cur) => [...cur, { productId: product.id, name: product.label, unitName: null, decimals: 3, quantity: String(Number(amount)) }]);
    setProduct(null);
    setAmount('');
    setFresh((f) => f + 1);
  };
  const save = async () => {
    setBusy(true);
    setProblem(null);
    const answer = await run(setParAction({ routeId: screen.route.id, expectedVersion: screen.route.version, lines: lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity) })) }), 'The usual stock is saved.');
    setBusy(false);
    if (answer !== null) setProblem(answer);
  };
  return (
    <section className={`${cardClass} space-y-3`} aria-label="Usual stock of the van">
      <div>
        <h2 className="text-base font-bold text-fg-strong">Usual stock of the van</h2>
        <p className="text-sm text-fg-muted">What the van should start the day with. When a van is loaded, it is topped up to these quantities.</p>
      </div>
      {may ? (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto] sm:items-end">
          <ChoicePicker key={fresh} label="Product" source="van-products" filters={{ route: screen.route.id }} choice={product} onChoice={setProduct} placeholder="Search products by name or code…" />
          <Field id={`${uid}-qty`} label="Quantity"><input id={`${uid}-qty`} className={fieldClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoComplete="off" /></Field>
          <button type="button" className={buttonClass} onClick={add}>Add to the list</button>
        </div>
      ) : null}
      {lines.length === 0 ? (
        <p role="status" className="rounded-lg border border-line p-6 text-center text-sm text-fg-muted">No usual stock set. Add the products this van sells most.</p>
      ) : (
        <ul className="space-y-2" aria-label="Usual stock">
          {lines.map((l) => (
            <li key={l.productId} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3">
              <p className="min-w-0 flex-1 basis-48 text-sm font-semibold text-fg-strong">{l.name}</p>
              <label className="flex items-center gap-2 text-sm">
                <span className="sr-only">Quantity of {l.name}</span>
                <input className={`${fieldClass} w-28`} inputMode="decimal" value={l.quantity} disabled={!may} onChange={(e) => setLines((cur) => cur.map((x) => (x.productId === l.productId ? { ...x, quantity: e.target.value } : x)))} autoComplete="off" />
                <span className="text-fg-muted">{l.unitName ?? 'unit'}</span>
              </label>
              {may ? <button type="button" className={buttonClass} onClick={() => setLines((cur) => cur.filter((x) => x.productId !== l.productId))} aria-label={`Take ${l.name} off the list`}>Take off</button> : null}
            </li>
          ))}
        </ul>
      )}
      {problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}
      {may ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={primaryClass} disabled={busy || !changed} onClick={() => void save()}>{busy ? 'Saving…' : 'Save the usual stock'}</button>
          {changed ? <button type="button" className={buttonClass} disabled={busy} onClick={() => { setLines(saved); setProblem(null); }}>Undo</button> : null}
        </div>
      ) : null}
    </section>
  );
}
