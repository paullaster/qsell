'use client';

import { useState } from 'react';
import { Package, RotateCcw, Trash2 } from 'lucide-react';
import { DiscountEditor } from '@/components/admin/cash-sales/till/DiscountEditor';
import { fieldClass } from '@/components/ui/screen-kit';
import { lineShown, pricedFor, readTypedPrice, type DocLine, type LineShown, type Priced } from '@/lib/selling/lines';
import type { LineDiscount } from '@/lib/till/cart';

const money = (amount: number): string => new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES' }).format(amount);
const inputClass = `${fieldClass} h-11 text-right font-mono tabular-nums`;
const labelClass = 'text-xs font-semibold text-fg-subtle xl:sr-only';

function UnitPrice({ line, unit, onPrice }: { line: DocLine; unit: number | null; onPrice: (price: number | null) => void }) {
  const shown = unit === null ? '' : unit.toFixed(2);
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const typed = readTypedPrice(draft);
    setDraft(null);
    if (typed === null) {
      setProblem('Give a price above nothing.');
      return;
    }
    setProblem(null);
    if (unit === null || Math.abs(typed - unit) >= 0.005) onPrice(typed);
  };
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1">
        <input
          id={`price-${line.key}`}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          aria-label={`Unit price of ${line.name}`}
          data-testid="line-price"
          className={`${inputClass} min-w-0 flex-1 ${line.price === undefined ? '' : 'border-amber-500 font-bold text-amber-700'}`}
          value={draft ?? shown}
          onFocus={(e) => { setDraft(shown); e.currentTarget.select(); }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.stopPropagation(); setDraft(null); setProblem(null); }
          }}
        />
        {line.price === undefined ? null : (
          <button type="button" className="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-fg-muted hover:bg-hover" aria-label={`Back to the list price for ${line.name}`} title="Back to the list price" data-testid="line-price-reset" onClick={() => onPrice(null)}>
            <RotateCcw className="size-4" aria-hidden />
          </button>
        )}
      </div>
      {problem === null ? null : <p role="alert" className="text-xs text-red-700">{problem}</p>}
    </div>
  );
}

/** What stands in the unit price column: a box for someone who may change the price, else the price charged (with what it was, when a discount took it down). */
function UnitCell({ line, shown, canPrice, onPrice }: { line: DocLine; shown: LineShown; canPrice: boolean; onPrice: (price: number | null) => void }) {
  if (line.package !== undefined) return <p className="flex h-11 items-center justify-end font-mono text-sm text-fg-muted">{shown.unit === null ? 'Set by the package' : money(shown.unit)}</p>;
  if (canPrice && line.discount === undefined) return <UnitPrice key={`${line.key}-${String(line.price)}`} line={line} unit={shown.unit} onPrice={onPrice} />;
  return (
    <p className="flex h-11 flex-col items-end justify-center font-mono text-sm tabular-nums text-fg-strong" data-testid="line-unit">
      {shown.was === null ? null : <span className="text-xs text-fg-muted line-through">{money(shown.was)}</span>}
      <span>{shown.unit === null ? '—' : money(shown.unit)}</span>
    </p>
  );
}

/**
 * The lines of a sales order, credit sale or sales invoice, as a table a person reads like an invoice: Item, Quantity, Unit price, Discount
 * (where the person may give one) and Line total. The head stays in view while a long list scrolls inside its own box, so the page around
 * it (the payment, the totals, Place order) never moves. Below a wide desktop each line is a card with the same names. The prices come from
 * the server (`priced`); a person who may change a price types it in the unit price box, and a discount has its own small form.
 */
export function SellingLines({ lines, priced, canPrice, canDiscount, onQuantity, onPrice, onDiscount, onRemove }: {
  lines: readonly DocLine[];
  priced: Priced | null;
  canPrice: boolean;
  canDiscount: boolean;
  onQuantity: (key: string, quantity: string) => void;
  onPrice: (key: string, price: number | null) => void;
  onDiscount: (key: string, discount: LineDiscount | null) => void;
  onRemove: (key: string) => void;
}) {
  const answers = pricedFor(priced, lines);
  const head = 'xl:sticky xl:top-0 xl:z-10 xl:bg-surface-sunken xl:px-3 xl:py-2 xl:text-xs xl:font-bold xl:tracking-wider xl:text-fg-subtle xl:uppercase';
  return (
    <div className="max-h-[52dvh] overflow-x-hidden overflow-y-auto rounded-xl border border-line bg-surface" data-testid="lines-box">
      <table className="block w-full xl:table xl:table-fixed" aria-label="Lines of the document">
        <thead className="hidden xl:table-header-group">
          <tr>
            <th scope="col" className={`${head} text-left`}>Item</th>
            <th scope="col" className={`${head} w-28 text-right`}>Quantity</th>
            <th scope="col" className={`${head} w-40 text-right`}>Unit price</th>
            {canDiscount ? <th scope="col" className={`${head} w-44 text-left`}>Discount</th> : null}
            <th scope="col" className={`${head} w-36 text-right`}>Line total</th>
            <th scope="col" className={`${head} w-14`}><span className="sr-only">Remove</span></th>
          </tr>
        </thead>
        <tbody className="block xl:table-row-group">
          {lines.map((l, at) => {
            const shown = lineShown(l, answers[at] ?? null);
            const isPackage = l.package !== undefined;
            return (
              <tr key={l.key} className="grid grid-cols-2 items-start gap-x-3 gap-y-2 border-b border-line p-3 last:border-b-0 xl:table-row xl:p-0" data-testid="order-line">
                <td className="col-span-2 min-w-0 xl:table-cell xl:px-3 xl:py-2 xl:align-middle">
                  <p className="font-semibold break-words text-fg-strong">{isPackage ? <Package className="mr-1 inline h-4 w-4" aria-hidden="true" /> : null}{l.name}</p>
                  {isPackage || l.listPrice === null ? null : <p className={`text-xs ${shown.changed === 'price' ? 'font-semibold text-amber-700' : 'text-fg-muted'}`}>List price {money(l.listPrice)}{shown.changed === 'price' ? ' · price changed' : ''}</p>}
                </td>
                <td className="min-w-0 xl:table-cell xl:px-3 xl:py-2 xl:align-middle">
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className={labelClass}>{isPackage ? 'Servings' : 'Quantity'}</span>
                    <input type="number" inputMode="decimal" min={isPackage ? 1 : 0.001} step={isPackage ? 1 : 'any'} className={inputClass} value={l.quantity} onChange={(e) => onQuantity(l.key, e.target.value)} aria-label={isPackage ? `Servings of ${l.name}` : `Quantity of ${l.name}`} data-testid="line-quantity" onFocus={(e) => e.currentTarget.select()} />
                  </label>
                </td>
                <td className="min-w-0 xl:table-cell xl:px-3 xl:py-2 xl:align-middle">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className={labelClass}>Unit price</span>
                    <UnitCell line={l} shown={shown} canPrice={canPrice} onPrice={(p) => onPrice(l.key, p)} />
                  </div>
                </td>
                {canDiscount ? (
                  <td className="col-span-2 min-w-0 xl:table-cell xl:px-3 xl:py-2 xl:align-middle">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className={labelClass}>Discount</span>
                      {isPackage ? <p className="text-xs text-fg-muted">Not on a package</p> : <DiscountEditor name={l.name} discount={l.discount} onChange={(d) => onDiscount(l.key, d)} />}
                    </div>
                  </td>
                ) : null}
                <td className="min-w-0 xl:table-cell xl:px-3 xl:py-2 xl:align-middle">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className={labelClass}>Line total</span>
                    <p className="flex h-11 flex-col items-end justify-center font-mono text-base font-bold tabular-nums text-fg-strong" data-testid="line-total"><span>{shown.total === null ? '—' : money(shown.total)}</span></p>
                  </div>
                </td>
                <td className="flex items-end justify-end xl:table-cell xl:px-3 xl:py-2 xl:text-right xl:align-middle">
                  <button type="button" className="inline-flex size-11 cursor-pointer items-center justify-center rounded-lg text-fg-muted hover:bg-hover hover:text-red-700" aria-label={`Remove ${l.name}`} title="Remove this line" onClick={() => onRemove(l.key)}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
