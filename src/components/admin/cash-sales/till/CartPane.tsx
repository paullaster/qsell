'use client';

import { useState } from 'react';
import { Check, Minus, PauseCircle, Pencil, Plus, RotateCcw, ShoppingCart, Trash2, UserRound } from 'lucide-react';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import type { Choice } from '@/lib/payment-options';
import { eachShown, totalShown, unitCount, type Cart } from '@/lib/till/cart';
import { kes } from '@/lib/till/tile-style';

export interface Priced {
  total: number;
  tax: number;
  lines: { productId: string; quantity: number; unitPrice: number; lineTotal: number }[];
}

/** The right side of the till: the sale as it stands, line by line, with the total the server worked out and the Pay button. */
export function CartPane({
  cart,
  priced,
  pricing,
  customer,
  heldCount,
  busy,
  onStep,
  onQuantity,
  canPrice,
  onPrice,
  onRemove,
  onCustomer,
  onHold,
  onHeld,
  onClear,
  onPay,
}: {
  cart: Cart;
  priced: Priced | null;
  pricing: string | null;
  customer: Choice | null;
  heldCount: number;
  busy: boolean;
  onStep: (key: string, step: 1 | -1) => void;
  onQuantity: (key: string, quantity: number) => void;
  /** The person may change an item's price while selling. */
  canPrice: boolean;
  onPrice: (key: string, price: number | null) => void;
  onRemove: (key: string) => void;
  onCustomer: (choice: Choice | null) => void;
  onHold: () => void;
  onHeld: () => void;
  onClear: () => void;
  onPay: () => void;
}) {
  const [choosingCustomer, setChoosingCustomer] = useState(false);
  const [editingPrice, setEditingPrice] = useState<{ key: string; draft: string } | null>(null);
  const finishPrice = (key: string, draft: string) => {
    const n = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(n) && n > 0) onPrice(key, n);
    setEditingPrice(null);
  };
  const used = new Set<number>();
  const priceOf = (productId: string, quantity: number): { unit: number; line: number } | null => {
    const at = priced?.lines.findIndex((l, n) => !used.has(n) && l.productId === productId && Math.abs(l.quantity - quantity) < 1e-9) ?? -1;
    const hit = at < 0 ? undefined : priced?.lines[at];
    if (hit === undefined) return null;
    used.add(at);
    return { unit: hit.unitPrice, line: hit.lineTotal };
  };
  const priceCell = (l: Cart[number], unit: number | null) => {
    const p = { unit };
    if (editingPrice?.key === l.key) {
      return (
        <form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={(e) => { e.preventDefault(); finishPrice(l.key, editingPrice.draft); }}>
                        <input aria-label={`New price of one ${l.name}`} data-testid="price-input" type="number" inputMode="decimal" min={0} step="0.01" autoFocus className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-right font-mono text-sm font-bold text-fg-strong focus:outline-2 focus:outline-indigo-500" value={editingPrice.draft} onChange={(e) => setEditingPrice({ key: l.key, draft: e.target.value })} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditingPrice(null); } }} />
                        <button type="submit" aria-label="Use this price" data-testid="price-apply" className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white hover:bg-indigo-500"><Check className="size-4" aria-hidden /></button>
                      </form>
      );
    }
    if (canPrice) {
      return (
        <button type="button" className={`inline-flex min-h-10 min-w-0 flex-1 items-center gap-1 truncate rounded-lg px-2 text-left text-xs hover:bg-hover ${l.price === undefined ? 'text-fg-muted' : 'font-semibold text-amber-700'}`} title="Change the price of one" data-testid="price-edit" onClick={() => setEditingPrice({ key: l.key, draft: String(l.price ?? p.unit ?? l.listPrice ?? '') })}>
                        <Pencil className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{eachShown(p.unit ?? null, l.listPrice)}{l.price === undefined ? '' : ' · price changed'}</span>
                      </button>
      );
    }
    return <p className="min-w-0 flex-1 truncate text-xs text-fg-muted">{eachShown(p.unit ?? null, l.listPrice)}</p>;
  };
  const empty = cart.length === 0;
  const canPay = !busy && priced !== null && !empty;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="till-cart">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="flex items-center gap-2 text-base font-bold text-fg-strong"><ShoppingCart className="size-5" aria-hidden />Sale{empty ? '' : <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-xs text-white" data-testid="till-count">{unitCount(cart)}</span>}</h2>
        <div className="flex items-center gap-1">
          <button type="button" className="inline-flex min-h-10 items-center gap-1 rounded-lg px-3 text-sm font-semibold text-fg hover:bg-hover disabled:opacity-40" disabled={empty || busy} onClick={onHold} title="Put this sale aside (F8)"><PauseCircle className="size-5" aria-hidden />Hold</button>
          <button type="button" className="inline-flex min-h-10 items-center gap-1 rounded-lg px-3 text-sm font-semibold text-fg hover:bg-hover" onClick={onHeld} title="Sales on hold (F6)" data-testid="till-held-button">On hold{heldCount > 0 ? <span className="rounded-full bg-amber-500 px-2 py-0.5 text-xs text-white">{heldCount}</span> : null}</button>
        </div>
      </div>

      <div className="border-b border-line px-4 py-2">
        {choosingCustomer || customer !== null ? (
          <ChoicePicker label="Customer (leave empty for a walk-in)" source="cash-sale-customers" choice={customer} onChoice={(c) => { onCustomer(c); if (c === null) setChoosingCustomer(false); }} placeholder="Search a customer…" />
        ) : (
          <button type="button" className="inline-flex min-h-10 items-center gap-2 rounded-lg px-1 text-sm font-semibold text-indigo-700 hover:underline" onClick={() => setChoosingCustomer(true)} data-testid="till-add-customer"><UserRound className="size-5" aria-hidden />Walk-in customer · add a customer</button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {empty ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-fg-muted" data-testid="sale-empty">
            <ShoppingCart className="size-10 opacity-40" aria-hidden />
            <p className="text-sm font-semibold">The sale is empty</p>
            <p className="text-xs">Tap a product, or scan a code, to start.</p>
          </div>
        ) : (
          <ul className="divide-y divide-line" data-testid="sale-lines">
            {cart.map((l) => {
              const p = priceOf(l.productId, l.quantity);
              const line = p?.line ?? (l.listPrice === null ? null : l.listPrice * l.quantity);
              return (
                <li key={l.key} className="space-y-1.5 px-2 py-2.5" data-testid="sale-line">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 text-sm font-semibold break-words text-fg-strong">{l.name}</p>
                    <p className={`shrink-0 font-mono text-sm font-bold ${p === null ? 'text-fg-muted' : 'text-fg-strong'}`} data-testid="line-total">{line === null ? '—' : kes(line)}</p>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="inline-flex items-center rounded-lg border border-line">
                      <button type="button" aria-label={`One less ${l.name}`} className="inline-flex size-10 items-center justify-center rounded-l-lg hover:bg-hover" onClick={() => onStep(l.key, -1)}><Minus className="size-4" aria-hidden /></button>
                      <input aria-label={`Quantity of ${l.name}`} type="number" inputMode="decimal" min={0} step="any" className="h-10 w-14 border-x border-line bg-surface text-center text-sm font-bold text-fg-strong focus:outline-none" value={l.quantity} onChange={(e) => onQuantity(l.key, Number(e.target.value))} />
                      <button type="button" aria-label={`One more ${l.name}`} className="inline-flex size-10 items-center justify-center rounded-r-lg hover:bg-hover" onClick={() => onStep(l.key, 1)}><Plus className="size-4" aria-hidden /></button>
                    </div>
                    {priceCell(l, p?.unit ?? null)}
                    {l.price === undefined || editingPrice?.key === l.key ? null : <button type="button" className="inline-flex size-10 items-center justify-center rounded-lg text-fg-muted hover:bg-hover" aria-label={`Back to the list price of ${l.name}`} title="Back to the list price" data-testid="price-reset" onClick={() => onPrice(l.key, null)}><RotateCcw className="size-4" aria-hidden /></button>}
                    <button type="button" className="inline-flex size-10 items-center justify-center rounded-lg text-fg-muted hover:bg-hover hover:text-red-700" aria-label={`Remove ${l.name}`} onClick={() => onRemove(l.key)}><Trash2 className="size-4" aria-hidden /></button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="space-y-2 border-t border-line bg-surface px-4 py-3" aria-live="polite">
        {priced === null ? null : <p className="flex justify-between text-xs text-fg-muted"><span>of which tax</span><span className="font-mono">{kes(priced.tax)}</span></p>}
        <p className="flex items-baseline justify-between gap-3"><span className="text-sm font-semibold text-fg">Total</span><span className="font-mono text-3xl font-bold text-fg-strong" data-testid="sale-total">{totalShown(priced?.total ?? null, cart)}</span></p>
        {pricing === null ? null : <p role="alert" className="text-sm text-red-700" data-testid="sale-pricing-problem">{pricing}</p>}
        <div className="flex gap-2">
          <button type="button" className="inline-flex min-h-14 flex-1 cursor-pointer items-center justify-center rounded-xl bg-emerald-600 px-4 text-lg font-bold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50" disabled={!canPay} onClick={onPay} data-testid="till-pay">Pay{priced === null ? '' : ` ${kes(priced.total)}`}<span className="ml-2 hidden text-xs font-medium opacity-80 sm:inline">F4</span></button>
          {empty ? null : <button type="button" className="inline-flex min-h-14 cursor-pointer items-center justify-center rounded-xl border border-line px-4 text-sm font-semibold text-fg hover:bg-hover disabled:opacity-50" disabled={busy} onClick={onClear} data-testid="till-clear">Clear</button>}
        </div>
      </div>
    </div>
  );
}
