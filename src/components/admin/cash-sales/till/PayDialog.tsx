'use client';

import { useState } from 'react';
import { Banknote, CreditCard, Delete, Smartphone, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { KEYPAD_KEYS, keypad, payState, payWords, quickCash } from '@/server/domains/selling/cash-sales/till-rules';
import { planTenders, MAX_TENDERS, type TenderKind } from '@/server/domains/selling/cash-sales/tender-rules';
import type { TillStart } from '@/server/domains/selling/cash-sales/till-actions';
import { kes } from '@/lib/till/tile-style';
import { orElse } from '@/lib/values';

type Method = TillStart['methods'][number];
interface Row {
  key: string;
  method: Method;
  amount: number;
  reference: string;
}

const ICON: Record<TenderKind, typeof Banknote> = { cash: Banknote, mobile_money: Smartphone, card: CreditCard };
const TONE = { idle: 'text-slate-300', short: 'text-amber-300', good: 'text-emerald-300' } as const;
const WORDS: Record<TenderKind, string> = { cash: 'Cash', mobile_money: 'M-Pesa', card: 'Card' };
let counter = 0;
const nextKey = (): string => `pay-${String((counter += 1))}`;
const cents = (n: number): number => Math.round(n * 100) / 100;

/** Taking the payment: the ways of paying as big buttons, a number pad, the cash buttons, a split across ways, and the change as it will be. */
export function PayDialog({ total, methods, busy, problem, unfinished, onPay, onClose }: { total: number; methods: Method[]; busy: boolean; problem: string | null; unfinished: boolean; onPay: (tenders: { methodId: string; amount: number; reference: string }[]) => void; onClose: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [method, setMethod] = useState<Method | null>(methods.find((m) => m.kind === 'cash') ?? methods[0] ?? null);
  const [entry, setEntry] = useState('');

  const paid = cents(rows.reduce((s, r) => s + r.amount, 0));
  const left = cents(Math.max(total - paid, 0));
  const plan = rows.length === 0 ? null : planTenders(total, rows.map((r) => ({ methodId: r.method.id, kind: r.method.kind, amount: r.amount, reference: r.reference.trim() === '' ? null : r.reference.trim() })));
  const words = payWords(payState(total, paid), kes);
  const needsReference = rows.some((r) => r.method.requiresReference && r.reference.trim() === '');
  const entered = Number(entry);
  const canAdd = method !== null && entered > 0 && rows.length < MAX_TENDERS && left > 0;
  let buttonWords = 'Complete sale';
  if (unfinished) buttonWords = 'Finish payment';
  if (busy) buttonWords = 'Working…';
  const ready = plan?.ok === true && !needsReference && !busy;

  const add = (m: Method, amount: number) => {
    if (amount <= 0 || rows.length >= MAX_TENDERS) return;
    setRows((current) => [...current, { key: nextKey(), method: m, amount: cents(amount), reference: '' }]);
    setEntry('');
  };
  const pick = (m: Method) => {
    setMethod(m);
    setEntry('');
  };

  return (
    <Modal title="Take payment" onClose={onClose} wide>
      <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr] lg:grid-rows-[auto_1fr] lg:gap-x-5">
        <div className="space-y-4 lg:col-start-1 lg:row-start-1">
          <div className="rounded-2xl bg-slate-900 p-5 text-white dark:bg-slate-800" aria-live="polite">
            <p className="text-sm text-slate-300">Total to pay</p>
            <p className="font-mono text-4xl font-bold" data-testid="pay-total">{kes(total)}</p>
            <p className={`mt-2 text-lg font-semibold ${TONE[words.tone]}`} data-testid="pay-state">{words.text}</p>
          </div>

          {rows.length === 0 ? null : (
            <ul className="space-y-2" data-testid="pay-rows">
              {rows.map((r) => (
                <li key={r.key} className="space-y-2 rounded-xl border border-line p-3" data-testid="pay-row">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-fg-strong">{r.method.name}{r.method.kind === 'cash' ? ' handed over' : ''}</p>
                    <div className="flex items-center gap-2"><span className="font-mono font-bold">{kes(r.amount)}</span>
                      <button type="button" className="inline-flex size-10 items-center justify-center rounded-lg text-fg-muted hover:bg-hover hover:text-red-700" aria-label={`Remove ${r.method.name} ${kes(r.amount)}`} onClick={() => setRows((c) => c.filter((x) => x.key !== r.key))}><Trash2 className="size-4" aria-hidden /></button></div>
                  </div>
                  {r.method.requiresReference ? (
                    <label className="block text-xs font-medium text-fg-muted">{r.method.kind === 'card' ? 'Card slip number' : 'M-Pesa code'}
                      <input className="mt-1 min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-base font-semibold text-fg-strong uppercase focus:border-indigo-500 focus:outline-none" value={r.reference} maxLength={60} autoComplete="off" data-testid="pay-reference" onChange={(e) => setRows((c) => c.map((x) => (x.key === r.key ? { ...x, reference: e.target.value } : x)))} />
                    </label>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {problem === null ? null : <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-700" data-testid="sale-problem">{problem}</p>}
          {plan?.ok === false ? <p role="alert" className="text-sm text-amber-700" data-testid="sale-plan-problem">{plan.error}</p> : null}

        </div>

        <div className="space-y-3 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="Ways of paying">
            {methods.map((m) => {
              const Icon = ICON[m.kind];
              const on = method?.id === m.id;
              return (
                <button key={m.id} type="button" aria-pressed={on} data-testid="pay-method" onClick={() => pick(m)} className={`flex min-h-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border px-2 text-sm font-bold ${on ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-line bg-surface text-fg hover:bg-hover'}`}>
                  <Icon className="size-6" aria-hidden />{orElse(m.name, WORDS[m.kind])}
                </button>
              );
            })}
          </div>
          {methods.length === 0 ? <p role="alert" className="text-sm text-amber-700">No way of paying is set up for this till. Ask an administrator to set up cash, M-Pesa or card payment methods.</p> : null}

          {left > 0 && method !== null ? (
            <>
              {method.kind === 'cash' ? (
                <div className="flex flex-wrap gap-2" role="group" aria-label="Cash handed over" data-testid="quick-cash">
                  {quickCash(left).map((amount, n) => (
                    <button key={amount} type="button" className="inline-flex min-h-12 cursor-pointer items-center rounded-xl border border-line bg-surface px-4 text-base font-bold text-fg hover:bg-hover" onClick={() => add(method, amount)}>{n === 0 ? `Exact ${kes(amount)}` : kes(amount)}</button>
                  ))}
                </div>
              ) : (
                <button type="button" className="inline-flex min-h-12 w-full cursor-pointer items-center justify-center rounded-xl border border-indigo-600 bg-indigo-600/10 px-4 text-base font-bold text-indigo-700 hover:bg-indigo-600/20" onClick={() => add(method, left)} data-testid="pay-full">Pay the full {kes(left)} with {method.name}</button>
              )}
              <div className="space-y-2">
                <label className="block text-xs font-medium text-fg-muted" htmlFor="pay-amount">{method.kind === 'cash' ? 'Cash handed over (KES)' : 'Amount (KES)'}</label>
                <input id="pay-amount" inputMode="decimal" autoComplete="off" className="min-h-14 w-full rounded-xl border border-line bg-surface px-4 text-right font-mono text-3xl font-bold text-fg-strong focus:border-indigo-500 focus:outline-none" value={entry} placeholder="0" onChange={(e) => setEntry(/^\d*\.?\d{0,2}$/.test(e.target.value) ? e.target.value : entry)} onKeyDown={(e) => { if (e.key === 'Enter' && canAdd) { e.preventDefault(); add(method, entered); } }} data-testid="pay-amount" />
                <div className="grid grid-cols-3 gap-2" role="group" aria-label="Number pad">
                  {KEYPAD_KEYS.map((k) => (
                    <button key={k} type="button" className="inline-flex min-h-14 cursor-pointer items-center justify-center rounded-xl border border-line bg-surface text-2xl font-bold text-fg-strong hover:bg-hover active:bg-hover" onClick={() => setEntry((cur) => keypad(cur, k))}>{k}</button>
                  ))}
                  <button type="button" className="inline-flex min-h-14 cursor-pointer items-center justify-center rounded-xl border border-line bg-surface text-fg hover:bg-hover" aria-label="Delete the last digit" onClick={() => setEntry((cur) => keypad(cur, 'back'))}><Delete className="size-6" aria-hidden /></button>
                  <button type="button" className="inline-flex min-h-14 cursor-pointer items-center justify-center rounded-xl border border-line bg-surface text-sm font-bold text-fg hover:bg-hover" onClick={() => setEntry('')}>Clear</button>
                  <button type="button" className="inline-flex min-h-14 cursor-pointer items-center justify-center rounded-xl bg-indigo-600 text-base font-bold text-white hover:bg-indigo-500 disabled:opacity-50" disabled={!canAdd} onClick={() => add(method, entered)} data-testid="pay-add">Add</button>
                </div>
              </div>
            </>
          ) : null}
        </div>
        <div className="lg:col-start-1 lg:row-start-2 lg:self-end">
          <button type="button" className="inline-flex min-h-16 w-full cursor-pointer items-center justify-center rounded-2xl bg-emerald-600 text-xl font-bold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50" disabled={!ready} onClick={() => plan?.ok === true && onPay(rows.map((r) => ({ methodId: r.method.id, amount: r.amount, reference: r.reference })))} data-testid="pay-complete">
            {buttonWords}
          </button>
        </div>
      </div>
    </Modal>
  );
}
