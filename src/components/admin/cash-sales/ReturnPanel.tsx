'use client';

import { useEffect, useState } from 'react';
import { finishReturnAction, returnableSaleAction, returnSaleAction } from '@/server/domains/selling/cash-sales/cash-sale-actions';
import type { ReturnSummary } from '@/server/domains/selling/cash-sales/counter-return-service';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, Field, buttonClass, cardClass, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';

type Loaded = NonNullable<Extract<Awaited<ReturnType<typeof returnableSaleAction>>, { ok: true }>['data']>;

const money = (amount: number): string => `KES ${amount.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function StatusLine({ ret }: { ret: ReturnSummary }) {
  if (ret.status === 'completed') return <Chip tone="green">{ret.cashPaid > 0 ? `${money(ret.cashPaid)} handed back` : 'Refunded'}</Chip>;
  if (ret.status === 'refund_pending') return <Chip tone="amber">Refund waiting for approval</Chip>;
  if (ret.status === 'refund_approved') return <Chip tone="amber">Refund approved, to be paid</Chip>;
  return <Chip tone="red">Credited, refund not asked for</Chip>;
}

/** Taking goods back from a counter sale: what is returned, why, whether it goes back into stock, and how the customer is paid back. */
export function ReturnPanel({ orderId, onClose, onChanged }: { orderId: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const [sale, setSale] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<Choice | null>(null);
  const [note, setNote] = useState('');
  const [restock, setRestock] = useState(true);
  const [method, setMethod] = useState<Choice | null>(null);
  const [phone, setPhone] = useState('');
  const [recipient, setRecipient] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [unfinished, setUnfinished] = useState<string | null>(null);
  const [result, setResult] = useState<ReturnSummary | null>(null);

  useEffect(() => {
    let live = true;
    void returnableSaleAction(orderId).then((r) => {
      if (!live) return;
      if (!r.ok) setLoadError(r.error);
      else if (r.data === null) setLoadError(r.message ?? 'That sale could not be returned.');
      else setSale(r.data);
    });
    return () => {
      live = false;
    };
  }, [orderId]);

  const lines = sale === null ? [] : sale.lines.flatMap((l) => (Number(counts[l.productId]) > 0 ? [{ productId: l.productId, quantity: Number(counts[l.productId]) }] : []));
  const total = sale === null ? 0 : lines.reduce((sum, l) => sum + l.quantity * (sale.lines.find((x) => x.productId === l.productId)?.unitPrice ?? 0), 0);
  const kind = method?.meta?.kind;

  const finish = (r: Awaited<ReturnType<typeof returnSaleAction>>) => {
    if (r.ok) {
      setResult(r.data);
      setProblem(null);
      setUnfinished(null);
    } else {
      setProblem(r.error);
      setUnfinished(r.unfinished?.returnId ?? null);
    }
  };
  const submit = async () => {
    if (method === null || reason === null) return;
    setBusy(true);
    setProblem(null);
    const r = await returnSaleAction({ orderId, lines, reason: { code: reason.id, text: note }, restock, refund: { methodId: method.id, phone, recipient }, key });
    setBusy(false);
    finish(r);
    await onChanged();
  };
  const retry = async () => {
    if (unfinished === null) return;
    setBusy(true);
    const r = await finishReturnAction(unfinished);
    setBusy(false);
    finish(r);
    await onChanged();
  };

  if (loadError !== null) {
    return (
      <section className={`${cardClass} space-y-2`} aria-label="Return goods" data-testid="return-panel">
        <p role="alert" className="text-sm text-fg-muted" data-testid="return-load-error">{loadError}</p>
        <button type="button" className={buttonClass} onClick={onClose}>Close</button>
      </section>
    );
  }
  if (sale === null) return <section className={cardClass} aria-label="Return goods" aria-busy="true"><p className="text-sm text-fg-muted">Loading the sale…</p></section>;
  if (result !== null) {
    let goods = ', goods not put back in stock';
    if (result.restock) goods = result.stockBack ? ', goods back in stock' : ', goods not yet counted in';
    return (
      <section className={`${cardClass} space-y-2 text-sm`} aria-label="Return done" data-testid="return-result">
        <h2 className="text-base font-bold text-fg-strong">Return {result.creditNoteNo}</h2>
        <p className="text-fg-muted">Sale {result.orderNumber} · {money(result.amount)} credited{goods}.</p>
        <p><StatusLine ret={result} /></p>
        {result.next === null ? null : <p className="text-amber-700">{result.next}</p>}
        <button type="button" className={primaryClass} onClick={onClose}>Done</button>
      </section>
    );
  }
  return (
    <form aria-label="Return goods" className={`${cardClass} space-y-3`} data-testid="return-panel" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 className="text-base font-bold text-fg-strong">Return goods from sale {sale.orderNumber}</h2>
      <p className="text-sm text-fg-muted">{sale.customerName}. Enter how many of each are coming back.</p>
      {sale.made.length === 0 ? null : <ul className="space-y-1 text-sm text-fg-muted" data-testid="returns-made">{sale.made.map((m) => <li key={m.returnId}>{m.creditNoteNo}: {money(m.amount)} <StatusLine ret={m} /></li>)}</ul>}
      <ul className="space-y-2">
        {sale.lines.map((l) => (
          <li key={l.productId} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-2" data-testid="return-line">
            <span className="min-w-0 flex-1 break-words text-fg-strong">{l.description}<span className="block text-xs text-fg-muted">{l.remainingQuantity} of {l.soldQuantity} can still be returned · {money(l.unitPrice)} each</span></span>
            <input aria-label={`Quantity of ${l.description} returned`} type="number" inputMode="decimal" min={0} max={l.remainingQuantity} step="any" className={`${fieldClass} w-24`} value={counts[l.productId] ?? ''} onChange={(e) => setCounts((c) => ({ ...c, [l.productId]: e.target.value }))} />
          </li>
        ))}
      </ul>
      <div className="grid gap-3 sm:grid-cols-2">
        <ChoicePicker label="Why" source="return-reasons" choice={reason} onChoice={setReason} clearable={false} required placeholder="Choose a reason…" />
        <Field id="return-note" label="What the customer said (optional)"><input id="return-note" className={fieldClass} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" className="size-4" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
        The goods are fit to sell again: put them back in stock
      </label>
      <ChoicePicker label="Pay the customer back by" source="counter-refund-methods" choice={method} onChoice={setMethod} clearable={false} required placeholder="Cash or M-Pesa…" />
      {kind === 'mobile_money' ? <Field id="return-phone" label="M-Pesa number the refund goes to"><input id="return-phone" type="tel" className={fieldClass} value={phone} maxLength={20} onChange={(e) => setPhone(e.target.value)} /></Field> : null}
      {kind === 'cash' ? <Field id="return-recipient" label="Who takes the cash" hint={`Left empty it is ${sale.customerName}.`}><input id="return-recipient" className={fieldClass} value={recipient} maxLength={80} onChange={(e) => setRecipient(e.target.value)} /></Field> : null}
      <p className="text-lg font-semibold text-fg-strong" data-testid="return-total">To refund: {money(total)}</p>
      {problem === null ? null : <p role="alert" className="text-sm text-red-700" data-testid="return-problem">{problem}</p>}
      <div className="flex flex-wrap gap-2">
        {unfinished === null ? <button type="submit" className={primaryClass} disabled={busy || lines.length === 0 || reason === null || method === null}>{busy ? 'Working…' : 'Return and refund'}</button> : <button type="button" className={primaryClass} disabled={busy} onClick={() => void retry()}>{busy ? 'Working…' : 'Finish return'}</button>}
        <button type="button" className={buttonClass} onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
