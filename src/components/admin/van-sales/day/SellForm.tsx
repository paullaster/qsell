'use client';

import { useEffect, useState } from 'react';
import { priceVanSaleAction, sellVanAction, takeOrderAction, type DayScreen, type PricedSale } from '@/server/domains/van-sales/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { buttonClass, primaryClass } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';
import { kes } from '@/lib/till/tile-style';
import { paymentState, saleLinesOf, tendersOf, type TypedLine, type TypedTender } from '@/lib/van-sales/sell';
import type { DayCall } from './call';

function sellWords(busy: boolean, kind: 'cash' | 'credit', ordering: boolean): string {
  if (ordering) return busy ? 'Taking the order…' : 'Take the order';
  if (busy) return 'Selling…';
  return kind === 'credit' ? 'Sell on account' : 'Complete the sale';
}

function payWords(pay: { short: number; change: number }): string {
  if (pay.short > 0) return `${kes(pay.short)} still to pay`;
  return pay.change > 0 ? `Change to give ${kes(pay.change)}` : 'Paid in full';
}

const inputClass = 'min-h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm';

/** What the rep types to sell at a visit: the products on the van, how many, and how it is paid (now, or on the customer's account). */
export function SellForm({ screen, visitId, customer, mode, run, onDone, onCancel }: { screen: DayScreen; visitId: string; customer: string; mode: 'sell' | 'order'; run: DayCall; onDone: () => void; onCancel: () => void }) {
  const limits = screen.repLimits;
  const ordering = mode === 'order';
  const [kind, setKind] = useState<'cash' | 'credit'>('cash');
  const [neededOn, setNeededOn] = useState('');
  const [rows, setRows] = useState<TypedLine[]>([]);
  const [tenders, setTenders] = useState<TypedTender[]>([{ methodId: screen.tenders[0]?.id ?? '', amount: '', reference: '' }]);
  const [pick, setPick] = useState<Choice | null>(null);
  const [fresh, setFresh] = useState(0);
  const [priced, setPriced] = useState<PricedSale | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saleKey] = useState(() => crypto.randomUUID());
  const lines = saleLinesOf(rows);
  const wire = JSON.stringify(lines);

  useEffect(() => {
    let current = true;
    const parsed = JSON.parse(wire) as ReturnType<typeof saleLinesOf>;
    if (parsed.length === 0) return;
    const timer = setTimeout(() => {
      void priceVanSaleAction({ dayId: screen.detail.day.id, visitId, kind: ordering ? 'order' : kind, lines: parsed }).then((r) => {
        if (!current) return;
        if (r.ok) {
          setPriced(r.data);
          setProblem(null);
        } else {
          setPriced(null);
          setProblem(r.error);
        }
      });
    }, 350);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [wire, kind, ordering, visitId, screen.detail.day.id]);

  const shown = lines.length > 0 ? priced : null;
  const total = shown?.total ?? 0;
  const pay = paymentState(total, tenders);
  const setRow = (i: number, over: Partial<TypedLine>) => setRows((all) => all.map((r, at) => (at === i ? { ...r, ...over } : r)));
  const setTender = (i: number, over: Partial<TypedTender>) => setTenders((all) => all.map((t, at) => (at === i ? { ...t, ...over } : t)));
  const add = (choice: Choice | null) => {
    if (choice === null) return;
    setRows((all) => (all.some((r) => r.productId === choice.id) ? all : [...all, { productId: choice.id, name: choice.label, quantity: '1', discount: '', price: '' }]));
    setPick(null);
    setFresh((f) => f + 1);
  };
  const ready = shown !== null && lines.length > 0 && (ordering || kind === 'credit' || pay.short === 0);
  const submit = async () => {
    setBusy(true);
    const answer = await run(
      ordering
        ? takeOrderAction({ dayId: screen.detail.day.id, visitId, saleKey, neededOn, lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })) })
        : sellVanAction({ dayId: screen.detail.day.id, visitId, kind, saleKey, lines, ...(kind === 'cash' ? { tenders: tendersOf(tenders) } : {}) }),
      (s) => {
        if (ordering) return s.lastOrder === undefined ? 'Order taken.' : `${customer}: order ${s.lastOrder.orderNumber} taken for ${kes(s.lastOrder.total)}.`;
        const sale = s.lastSale;
        if (sale === undefined) return 'Sold.';
        const change = sale.changeDue > 0 ? ` Change to give: ${kes(sale.changeDue)}.` : '';
        return `${customer}: sold ${kes(sale.total)}${sale.kind === 'credit' ? ' on account' : ''} (${sale.orderNumber}).${change}`;
      },
    );
    setBusy(false);
    if (answer === null) onDone();
    else setProblem(answer);
  };

  return (
    <form aria-label={ordering ? `Take an order from ${customer}` : `Sell to ${customer}`} className="space-y-3 rounded-lg border border-line bg-surface-sunken p-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {!ordering && limits?.maySellOnCredit === true ? (
        <div role="group" aria-label="How it is paid" className="flex gap-2">
          <button type="button" className={kind === 'cash' ? primaryClass : buttonClass} aria-pressed={kind === 'cash'} onClick={() => setKind('cash')}>Paid now</button>
          <button type="button" className={kind === 'credit' ? primaryClass : buttonClass} aria-pressed={kind === 'credit'} onClick={() => setKind('credit')}>On account</button>
        </div>
      ) : null}
      <ChoicePicker key={fresh} label="Add a product" source={ordering ? 'van-rep-products' : 'van-stock-products'} filters={ordering ? {} : { day: screen.detail.day.id }} choice={pick} onChoice={add} placeholder={ordering ? 'Search products by name or code…' : 'Search what is on the van…'} />
      {rows.length === 0 ? null : (
        <ul className="space-y-2" aria-label="What is being sold">
          {rows.map((r, i) => (
            <li key={r.productId} className="space-y-2 rounded-lg border border-line bg-surface p-2">
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 text-sm font-semibold text-fg-strong">{r.name}</p>
                <button type="button" className={buttonClass} aria-label={`Remove ${r.name}`} onClick={() => setRows((all) => all.filter((_, at) => at !== i))}>Remove</button>
              </div>
              <div className="flex flex-wrap gap-2">
                <label className="min-w-24 flex-1 text-xs text-fg-muted">Quantity
                  <input className={inputClass} inputMode="decimal" value={r.quantity} onChange={(e) => setRow(i, { quantity: e.target.value })} aria-label={`Quantity of ${r.name}`} />
                </label>
                {!ordering && limits?.mayOverridePrice === true ? (
                  <label className="min-w-24 flex-1 text-xs text-fg-muted">Price for one
                    <input className={inputClass} inputMode="decimal" value={r.price} placeholder="Usual price" onChange={(e) => setRow(i, { price: e.target.value })} aria-label={`Price of ${r.name}`} />
                  </label>
                ) : null}
                {!ordering && (limits?.maxDiscountPercent ?? 0) > 0 ? (
                  <label className="min-w-24 flex-1 text-xs text-fg-muted">Discount % (up to {limits?.maxDiscountPercent})
                    <input className={inputClass} inputMode="decimal" value={r.discount} onChange={(e) => setRow(i, { discount: e.target.value })} aria-label={`Discount on ${r.name}`} />
                  </label>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {shown === null ? null : <p className="text-base font-bold text-fg-strong" data-testid="sale-total">Total {kes(shown.total)}</p>}
      {!ordering && kind === 'cash' && shown !== null ? (
        <div className="space-y-2" role="group" aria-label="Payment">
          {tenders.map((t, i) => (
            // eslint-disable-next-line react/no-array-index-key -- rows are only added at the end and never reordered
            <div key={i} className="flex flex-wrap gap-2">
              <div role="group" aria-label="Paid by" className="flex min-w-32 flex-1 flex-wrap gap-2">
                {screen.tenders.map((m) => (
                  <button key={m.id} type="button" className={t.methodId === m.id ? primaryClass : buttonClass} aria-pressed={t.methodId === m.id} onClick={() => setTender(i, { methodId: m.id })}>{m.name}</button>
                ))}
              </div>
              <label className="min-w-24 flex-1 text-xs text-fg-muted">Amount
                <input className={inputClass} inputMode="decimal" value={t.amount} onChange={(e) => setTender(i, { amount: e.target.value })} aria-label="Amount handed over" />
              </label>
              {screen.tenders.find((m) => m.id === t.methodId)?.requiresReference === true ? (
                <label className="min-w-24 flex-1 text-xs text-fg-muted">Reference
                  <input className={inputClass} value={t.reference} onChange={(e) => setTender(i, { reference: e.target.value })} aria-label="Payment reference" />
                </label>
              ) : null}
            </div>
          ))}
          <p className="text-sm text-fg-muted" aria-live="polite">{payWords(pay)}</p>
        </div>
      ) : null}
      {ordering ? (
        <label className="block text-xs text-fg-muted">Needed on (optional)
          <input type="date" className={inputClass} value={neededOn} onChange={(e) => setNeededOn(e.target.value)} aria-label="Day the customer needs the order" />
        </label>
      ) : null}
      {problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryClass} disabled={busy || !ready}>{sellWords(busy, kind, ordering)}</button>
        <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
