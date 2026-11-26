'use client';

import { useState } from 'react';
import { collectAction, type DayScreen } from '@/server/domains/van-sales/actions';
import type { OwingView } from '@/server/domains/van-sales/collections';
import { buttonClass, primaryClass } from '@/components/ui/screen-kit';
import { kes } from '@/lib/till/tile-style';
import type { DayCall } from './call';

const inputClass = 'min-h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm';

/** What the customer owes (the open invoices, oldest first) and the form to take a payment against it: cash, M-Pesa or card. */
export function CollectForm({ screen, owing, customer, run, onDone, onCancel }: { screen: DayScreen; owing: OwingView; customer: string; run: DayCall; onDone: () => void; onCancel: () => void }) {
  const [methodId, setMethodId] = useState(screen.tenders[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const method = screen.tenders.find((m) => m.id === methodId);
  const submit = async () => {
    setBusy(true);
    setProblem(null);
    const answer = await run(collectAction({ dayId: screen.detail.day.id, visitId: owing.visitId, methodId, amount, reference, key }), `${kes(Number(amount))} was collected from ${customer}.`);
    setBusy(false);
    if (answer === null) onDone();
    else setProblem(answer);
  };
  return (
    <form aria-label={`Collect from ${customer}`} className="space-y-3 rounded-lg border border-line bg-surface-sunken p-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-fg-strong" data-testid="owing-total">{customer} owes {kes(owing.total)}</p>
        <ul className="space-y-1 text-xs text-fg-muted" aria-label="What is owed">
          {owing.items.map((i) => <li key={i.documentNo} className="flex justify-between gap-3"><span>{i.documentNo}{i.dueDate === null ? '' : ` · due ${i.dueDate}`}</span><span className="font-mono">{kes(i.remaining)}</span></li>)}
        </ul>
      </div>
      <div role="group" aria-label="Paid by" className="flex flex-wrap gap-2">
        {screen.tenders.map((m) => <button key={m.id} type="button" className={methodId === m.id ? primaryClass : buttonClass} aria-pressed={methodId === m.id} onClick={() => setMethodId(m.id)}>{m.name}</button>)}
      </div>
      <label className="block text-xs text-fg-muted">Amount paid (KES)
        <input className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount collected" />
      </label>
      {method?.requiresReference === true ? (
        <label className="block text-xs text-fg-muted">Reference (M-Pesa code or slip number)
          <input className={inputClass} value={reference} onChange={(e) => setReference(e.target.value)} aria-label="Payment reference" autoComplete="off" />
        </label>
      ) : null}
      {problem === null ? null : <p role="alert" className="text-sm text-red-700">{problem}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryClass} disabled={busy || amount.trim() === ''}>{busy ? 'Saving…' : 'Collect'}</button>
        <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
