'use client';

import { useId, useState } from 'react';
import { useCustomerCreated } from '@/components/admin/customer-created';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { entryType, pickedCents, canMatchTotal, fromCents } from '@/lib/bank-statement';
import { chargeLeftCents, MAX_CHARGE_PARTS } from '@/lib/charge-split';
import { needsComment } from '@/lib/receipt-detail';
import type { Choice } from '@/lib/payment-options';
import { Field, buttonClass, dangerClass, fieldClass, money, primaryClass } from './ui';

export interface CandidateEntry {
  id: number;
  date: string;
  type: string;
  no: string;
  description: string;
  amount: string;
}

export interface Reason {
  choice: Choice | null;
  text: string;
}

export const NO_REASON: Reason = { choice: null, text: '' };

/** A reason from the company's list, with the comment box shown when that reason demands one. */
export function ReasonFields({ id, value, onChange }: { id: string; value: Reason; onChange: (v: Reason) => void }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <ChoicePicker label="Reason" source="statement-reasons" choice={value.choice} onChoice={(choice) => onChange({ ...value, choice })} clearable={false} required placeholder="Choose a reason…" />
      <Field id={`${id}-t`} label={needsComment(value.choice?.meta) ? 'Explain (required)' : 'Comment (optional)'} hint="Kept with your name, the time and where you did this from.">
        <input id={`${id}-t`} value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} className={fieldClass} required={needsComment(value.choice?.meta)} maxLength={300} autoComplete="off" />
      </Field>
    </div>
  );
}

/** Tick the entries of ours that this bank line stands for; they must add up to the line exactly. */
export function FindEntriesPanel({ lineAmount, candidates, busy, onMatch, onClose }: { lineAmount: string; candidates: CandidateEntry[] | null; busy: boolean; onMatch: (ids: number[]) => void; onClose: () => void }) {
  const [picked, setPicked] = useState<number[]>([]);
  const total = pickedCents(candidates ?? [], picked);
  return (
    <div className="space-y-2 rounded-lg border border-line p-3" role="group" aria-label="Choose what this line matches">
      <p className="text-xs text-fg-muted">Tick what the bank paid in or out with this line. They must add up to {money(lineAmount)} exactly.</p>
      {candidates === null ? <p className="text-xs">Looking…</p> : null}
      {candidates !== null && candidates.length === 0 ? <p className="text-xs text-fg-muted">Nothing in our records is waiting for this account.</p> : null}
      {candidates !== null && candidates.length > 0 ? (
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {candidates.map((c) => (
            <li key={c.id}>
              <label className="flex min-h-10 items-center gap-2 text-xs">
                <input type="checkbox" checked={picked.includes(c.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />
                <span><b>{entryType(c.type)} {c.no}</b> · {c.date} · {money(c.amount)}{c.description === '' ? '' : ` · ${c.description}`}</span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs" aria-live="polite">Chosen: <b>{money(fromCents(total))}</b> of {money(lineAmount)}</p>
      <div className="flex gap-2">
        <button type="button" className={primaryClass} disabled={busy || !canMatchTotal(total, lineAmount)} onClick={() => onMatch(picked)}>Match</button>
        <button type="button" className={buttonClass} onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

/** A deposit nobody recorded: choose who paid and how, and a posted receipt is made from the line. */
export function CustomerReceiptPanel({ accountId, lineAmount, lineDate, busy, onCreate, onClose }: { accountId: string; lineAmount: string; lineDate: string; busy: boolean; onCreate: (input: { customerId: string; paymentMethodId: string; allocate: 'oldest_first' | 'none' }) => void; onClose: () => void }) {
  const [customer, setCustomer] = useState<Choice | null>(null);
  useCustomerCreated(setCustomer);
  const [method, setMethod] = useState<Choice | null>(null);
  const [allocate, setAllocate] = useState<Choice | null>({ id: 'oldest_first', label: 'Apply to oldest invoices' });
  return (
    <form
      className="space-y-3 rounded-lg border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (customer === null || method === null) return;
        onCreate({ customerId: customer.id, paymentMethodId: method.id, allocate: allocate?.id === 'none' ? 'none' : 'oldest_first' });
      }}
    >
      <p className="text-xs text-fg-muted">This creates a posted receipt of {money(lineAmount)} dated {lineDate} and closes the line against it.</p>
      <ChoicePicker label="Customer" source="statement-customers" choice={customer} onChoice={setCustomer} clearable={false} required placeholder="Name, number or phone" createHref="/admin/customers/new" createLabel="+ Create a customer" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ChoicePicker label="Paid by" source="statement-receipt-methods" filters={{ account: accountId }} choice={method} onChoice={setMethod} clearable={false} required placeholder="How did they pay?" />
        <ChoicePicker label="Apply to invoices" source="statement-allocation-modes" choice={allocate} onChoice={setAllocate} clearable={false} required />
      </div>
      <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy || customer === null || method === null}>Create receipt</button><button type="button" className={buttonClass} onClick={onClose}>Close</button></div>
    </form>
  );
}

/** Setting a line aside, or undoing a match: both need a reason that is kept. */
export function ReasonPanel({ kind, busy, onSubmit, onClose }: { kind: 'ignore' | 'unmatch'; busy: boolean; onSubmit: (reason: { code: string; text?: string }) => void; onClose: () => void }) {
  const uid = useId();
  const [reason, setReason] = useState<Reason>(NO_REASON);
  const ignoring = kind === 'ignore';
  return (
    <form
      className="space-y-3 rounded-lg border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const text = reason.text.trim();
        onSubmit({ code: reason.choice?.id ?? '', text: text === '' ? undefined : text });
      }}
    >
      <p className="text-xs text-fg-muted">{ignoring ? 'Use this only when the bank moved money that we do not and will not record. It still counts in the reconciliation.' : 'The line goes back to the list; the entries become free to match again.'}</p>
      <ReasonFields id={uid} value={reason} onChange={setReason} />
      <div className="flex gap-2"><button type="submit" className={ignoring ? primaryClass : dangerClass} disabled={busy || reason.choice === null}>{ignoring ? 'Set aside' : 'Undo match'}</button><button type="button" className={buttonClass} onClick={onClose}>Close</button></div>
    </form>
  );
}

interface PartRow {
  key: number;
  account: Choice | null;
  amount: string;
  description: string;
}

/**
 * A charge the bank bundled (the fee, the duty on the fee, a tax) is placed part by part. The parts must come to the line
 * exactly: the form shows what is still to place, and the server checks again.
 */
export function SplitChargePanel({ lineAmount, busy, onSubmit, onClose }: { lineAmount: string; busy: boolean; onSubmit: (parts: { glAccountId: string; amount: string; description?: string }[]) => void; onClose: () => void }) {
  const uid = useId();
  const totalCents = Math.round(Math.abs(Number(lineAmount)) * 100);
  const [rows, setRows] = useState<PartRow[]>([
    { key: 1, account: null, amount: '', description: '' },
    { key: 2, account: null, amount: '', description: '' },
  ]);
  const [next, setNext] = useState(3);
  const left = chargeLeftCents(totalCents, rows.map((r) => r.amount));
  const set = (key: number, patch: Partial<PartRow>) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const complete = rows.every((r) => r.account !== null && r.amount.trim() !== '');
  return (
    <form
      className="space-y-3 rounded-lg border border-line p-3"
      aria-label="Split this charge"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(rows.flatMap((r) => (r.account === null ? [] : [{ glAccountId: r.account.id, amount: r.amount, description: r.description.trim() === '' ? undefined : r.description.trim() }])));
      }}
    >
      <p className="text-xs text-fg-muted">The bank took {money(String(Math.abs(Number(lineAmount))))} in one line. Place it part by part (for example the fee and the duty on it); the parts must come to exactly that.</p>
      {rows.map((r, i) => (
        <div key={r.key} role="group" aria-label={`Part ${String(i + 1)}`} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[2fr_1fr_2fr_auto]">
          <ChoicePicker label="Account" source="statement-expense-accounts" choice={r.account} onChoice={(account) => set(r.key, { account })} clearable={false} required placeholder="Which account?" />
          <Field id={`${uid}-a${String(r.key)}`} label="Amount">
            <input id={`${uid}-a${String(r.key)}`} value={r.amount} onChange={(e) => set(r.key, { amount: e.target.value })} className={fieldClass} inputMode="decimal" autoComplete="off" />
          </Field>
          <Field id={`${uid}-d${String(r.key)}`} label="Note (optional)">
            <input id={`${uid}-d${String(r.key)}`} value={r.description} onChange={(e) => set(r.key, { description: e.target.value })} className={fieldClass} maxLength={200} autoComplete="off" />
          </Field>
          {rows.length > 2 ? <button type="button" className={buttonClass} aria-label={`Remove part ${String(i + 1)}`} onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))}>Remove</button> : <span />}
        </div>
      ))}
      {rows.length < MAX_CHARGE_PARTS ? <button type="button" className={buttonClass} onClick={() => { setRows((all) => [...all, { key: next, account: null, amount: '', description: '' }]); setNext(next + 1); }}>Add a part</button> : null}
      <p className="text-xs" aria-live="polite">{left === 0 ? 'All of it is placed.' : left > 0 ? `Still to place: ${money(fromCents(left))}` : `Too much by ${money(fromCents(-left))}`}</p>
      <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy || !complete || left !== 0}>Record the charge</button><button type="button" className={buttonClass} onClick={onClose}>Close</button></div>
    </form>
  );
}

/** Interest or other money the bank paid in that is not a customer's payment: chosen account, optional note. */
export function IncomePanel({ lineAmount, busy, onSubmit, onClose }: { lineAmount: string; busy: boolean; onSubmit: (input: { incomeGlAccountId: string; description?: string }) => void; onClose: () => void }) {
  const uid = useId();
  const [account, setAccount] = useState<Choice | null>(null);
  const [note, setNote] = useState('');
  return (
    <form
      className="space-y-3 rounded-lg border border-line p-3"
      aria-label="Record this as income"
      onSubmit={(e) => {
        e.preventDefault();
        if (account === null) return;
        onSubmit({ incomeGlAccountId: account.id, description: note.trim() === '' ? undefined : note.trim() });
      }}
    >
      <p className="text-xs text-fg-muted">Use this for interest or other money the bank paid in that is not a customer&apos;s payment. {money(lineAmount)} is recorded against the account you choose and the line is closed.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ChoicePicker label="Income account" source="statement-income-accounts" choice={account} onChoice={setAccount} clearable={false} required placeholder="Which account?" />
        <Field id={`${uid}-n`} label="Note (optional)" hint="What it was, for example interest for the month.">
          <input id={`${uid}-n`} value={note} onChange={(e) => setNote(e.target.value)} className={fieldClass} maxLength={200} autoComplete="off" />
        </Field>
      </div>
      <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy || account === null}>Record the income</button><button type="button" className={buttonClass} onClick={onClose}>Close</button></div>
    </form>
  );
}
