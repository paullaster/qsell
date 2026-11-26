'use client';

import { useState } from 'react';
import { returnGoodsAction, type DayScreen } from '@/server/domains/van-sales/actions';
import type { ReturnableSale } from '@/server/domains/van-sales/returns';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { buttonClass, primaryClass } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';
import { kes } from '@/lib/till/tile-style';
import type { DayCall } from './call';

const inputClass = 'min-h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm';

/** Goods a customer gives back from an earlier cash sale made from this van: which sale, how many of what, why, whether they can be sold again, and how the customer is paid back. */
export function ReturnForm({ screen, sales, visitId, customer, run, onDone, onCancel }: { screen: DayScreen; sales: ReturnableSale[]; visitId: string; customer: string; run: DayCall; onDone: () => void; onCancel: () => void }) {
  const [orderId, setOrderId] = useState(sales[0]?.orderId ?? '');
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<Choice | null>(null);
  const [note, setNote] = useState('');
  const [restock, setRestock] = useState(true);
  const [methodId, setMethodId] = useState(screen.refundMethods[0]?.id ?? '');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const sale = sales.find((s) => s.orderId === orderId);
  const method = screen.refundMethods.find((m) => m.id === methodId);
  const lines = (sale?.lines ?? []).flatMap((l) => {
    const q = Number(counts[l.productId] ?? '');
    return Number.isFinite(q) && q > 0 ? [{ productId: l.productId, quantity: q, unitPrice: l.unitPrice }] : [];
  });
  const total = Math.round(lines.reduce((n, l) => n + l.quantity * l.unitPrice, 0) * 100) / 100;
  const submit = async () => {
    if (reason === null) return;
    setBusy(true);
    setProblem(null);
    const answer = await run(returnGoodsAction({ dayId: screen.detail.day.id, visitId, orderId, lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })), reason: { code: reason.id, text: note }, restock, refund: { methodId, phone }, key }), `Goods were taken back from ${customer}.`);
    setBusy(false);
    if (answer === null) onDone();
    else setProblem(answer);
  };
  return (
    <form aria-label={`Take goods back from ${customer}`} className="space-y-3 rounded-lg border border-line bg-surface-sunken p-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div role="group" aria-label="The sale" className="flex flex-wrap gap-2">
        {sales.map((s) => <button key={s.orderId} type="button" className={orderId === s.orderId ? primaryClass : buttonClass} aria-pressed={orderId === s.orderId} onClick={() => { setOrderId(s.orderId); setCounts({}); }}>{s.orderNumber}</button>)}
      </div>
      <ul className="space-y-2" aria-label="What can be returned">
        {(sale?.lines ?? []).map((l) => (
          <li key={l.productId} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-2">
            <span className="min-w-0 flex-1 basis-40 text-sm"><span className="font-semibold text-fg-strong">{l.description}</span> <span className="text-xs text-fg-muted">up to {String(l.remainingQuantity)} at {kes(l.unitPrice)}</span></span>
            <input className="min-h-10 w-24 rounded-lg border border-line bg-surface px-3 text-sm" inputMode="decimal" value={counts[l.productId] ?? ''} onChange={(e) => setCounts((c) => ({ ...c, [l.productId]: e.target.value }))} aria-label={`Quantity of ${l.description} returned`} placeholder="0" />
          </li>
        ))}
      </ul>
      <ChoicePicker label="Why" source="van-return-reasons" choice={reason} onChoice={setReason} clearable={false} required placeholder="Choose a reason…" />
      <label className="block text-xs text-fg-muted">Note (optional)
        <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} aria-label="Note on the return" />
      </label>
      <div role="group" aria-label="Condition of the goods" className="flex flex-wrap gap-2">
        <button type="button" className={restock ? primaryClass : buttonClass} aria-pressed={restock} onClick={() => setRestock(true)}>Fit to sell again</button>
        <button type="button" className={restock ? buttonClass : primaryClass} aria-pressed={!restock} onClick={() => setRestock(false)}>Damaged</button>
      </div>
      <div role="group" aria-label="Pay the customer back by" className="flex flex-wrap gap-2">
        {screen.refundMethods.map((m) => <button key={m.id} type="button" className={methodId === m.id ? primaryClass : buttonClass} aria-pressed={methodId === m.id} onClick={() => setMethodId(m.id)}>{m.name}</button>)}
      </div>
      {method?.kind === 'mobile_money' ? (
        <label className="block text-xs text-fg-muted">M-Pesa number the refund goes to
          <input className={inputClass} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={20} aria-label="M-Pesa number for the refund" />
        </label>
      ) : null}
      <p className="text-base font-bold text-fg-strong" data-testid="return-total">To pay back {kes(total)}</p>
      {problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryClass} disabled={busy || lines.length === 0 || reason === null || methodId === ''}>{busy ? 'Working…' : 'Take back and pay'}</button>
        <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
