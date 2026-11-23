'use client';

import { useState } from 'react';
import { Check, Percent, X } from 'lucide-react';
import { discountWords, readDiscount, type LineDiscount } from '@/lib/till/cart';

const toggle = (on: boolean) => `inline-flex h-10 min-w-12 items-center justify-center px-3 text-sm font-semibold ${on ? 'bg-indigo-600 text-white' : 'text-fg hover:bg-hover'}`;

/**
 * The discount on one sale line, shown only to someone who may offer one where they sell. A button opens a small form: a percentage or an
 * amount off each unit. The till only reads it to the cent; the server decides whether it may stand (permission, branch, floors, limit).
 */
export function DiscountEditor({ name, discount, onChange }: { name: string; discount: LineDiscount | undefined; onChange: (next: LineDiscount | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<LineDiscount['kind']>(discount?.kind ?? 'percent');
  const [draft, setDraft] = useState(discount === undefined ? '' : String(discount.value));
  const [problem, setProblem] = useState<string | null>(null);
  const apply = () => {
    const read = readDiscount(kind, Number(draft));
    if (read === null) {
      setProblem(kind === 'percent' ? 'Give a percentage above 0 and under 100.' : 'Give an amount above 0.');
      return;
    }
    setProblem(null);
    setEditing(false);
    onChange(read);
  };
  if (editing) {
    return (
      // A group, not a form: this editor also sits inside the order forms, and a form cannot hold a form (its button would place the order).
      <div role="group" className="w-full space-y-1" aria-label={`Discount on ${name}`} data-testid="discount-form">
        <div className="flex items-center gap-1">
          <div role="group" aria-label="Kind of discount" className="inline-flex shrink-0 overflow-hidden rounded-lg border border-line">
            <button type="button" aria-pressed={kind === 'percent'} className={toggle(kind === 'percent')} onClick={() => setKind('percent')}>%</button>
            <button type="button" aria-pressed={kind === 'amount'} className={toggle(kind === 'amount')} onClick={() => setKind('amount')}>KES</button>
          </div>
          <input aria-label={kind === 'percent' ? `Percent off ${name}` : `Amount off each ${name}`} data-testid="discount-input" type="number" inputMode="decimal" min={0} step="0.01" autoFocus className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-right font-mono text-sm font-bold text-fg-strong focus:outline-2 focus:outline-indigo-500" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); } if (e.key === 'Enter') { e.preventDefault(); apply(); } }} />
          <button type="button" aria-label="Give this discount" data-testid="discount-apply" onClick={apply} className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white hover:bg-indigo-500"><Check className="size-4" aria-hidden /></button>
          <button type="button" aria-label="Cancel the discount" className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-hover" onClick={() => { setEditing(false); setProblem(null); }}><X className="size-4" aria-hidden /></button>
        </div>
        {problem === null ? null : <p role="alert" className="text-xs text-red-700">{problem}</p>}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <button type="button" className={`inline-flex min-h-10 items-center gap-1 rounded-lg px-2 text-xs hover:bg-hover ${discount === undefined ? 'text-fg-muted' : 'font-semibold text-emerald-700'}`} data-testid="discount-edit" title="Give a discount on this item" onClick={() => { setKind(discount?.kind ?? 'percent'); setDraft(discount === undefined ? '' : String(discount.value)); setEditing(true); }}>
        <Percent className="size-3.5 shrink-0" aria-hidden />{discount === undefined ? 'Discount' : discountWords(discount)}
      </button>
      {discount === undefined ? null : <button type="button" className="inline-flex size-10 items-center justify-center rounded-lg text-fg-muted hover:bg-hover" aria-label={`Remove the discount on ${name}`} title="Remove the discount" data-testid="discount-remove" onClick={() => onChange(null)}><X className="size-4" aria-hidden /></button>}
    </div>
  );
}
