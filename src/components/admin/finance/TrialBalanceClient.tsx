'use client';

import { use, useId, useState } from 'react';
import { trialBalanceAction } from '@/server/domains/finance/actions';
import { Field, LoadFailed, Message, PageHeader, cardClass, fieldClass, money, primaryClass, type Notice, attempt } from './ui';

type Result = Extract<Awaited<ReturnType<typeof trialBalanceAction>>, { ok: true }>['data'];

const COLUMNS = [
  { key: 'od', head: 'Debit' }, { key: 'oc', head: 'Credit' }, { key: 'md', head: 'Debit' }, { key: 'mc', head: 'Credit' }, { key: 'cd', head: 'Debit' }, { key: 'cc', head: 'Credit' },
] as const;

export function TrialBalanceClient({ initialPromise, from, to }: { initialPromise: ReturnType<typeof trialBalanceAction>; from: string; to: string }) {
  const res = use(initialPromise);
  return res.ok ? <TrialBalanceView initial={res.data} from={from} to={to} /> : <LoadFailed error={res.error} />;
}

function TrialBalanceView({ initial, from: f0, to: t0 }: { initial: Result; from: string; to: string }) {
  const uid = useId();
  const [from, setFrom] = useState(f0);
  const [to, setTo] = useState(t0);
  const [data, setData] = useState<Result>(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const run = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const res = await attempt(trialBalanceAction(from, to));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setData(res.data);
  };

  const balanced = data.totalDebit === data.totalCredit;

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader title="Trial balance" intro="Opening balance, movement and closing balance per account, in the base currency. Totals come from the running balances kept with every posting." />
      <form onSubmit={(e) => void run(e)} className={`${cardClass} grid grid-cols-1 gap-3 sm:grid-cols-3`} aria-label="Trial balance range">
        <Field id={`${uid}-f`} label="From"><input id={`${uid}-f`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={fieldClass} required /></Field>
        <Field id={`${uid}-t`} label="To"><input id={`${uid}-t`} type="date" value={to} onChange={(e) => setTo(e.target.value)} className={fieldClass} required /></Field>
        <div className="flex items-end"><button type="submit" disabled={busy} className={primaryClass}>{busy ? 'Working…' : 'Show'}</button></div>
      </form>
      <Message notice={notice} />
      <p role="status" className={`text-sm font-semibold ${balanced ? 'text-emerald-700' : 'text-red-700'}`}>
        {balanced ? `In balance: ${money(data.totalDebit)} debits and credits.` : `Out of balance: debits ${money(data.totalDebit)}, credits ${money(data.totalCredit)}.`}
      </p>
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[52rem] text-left text-sm">
          <caption className="sr-only">Trial balance</caption>
          <thead className="bg-surface-sunken text-xs text-fg-muted">
            <tr>
              <th scope="col" rowSpan={2} className="px-3 py-2 font-semibold">Account</th>
              <th scope="colgroup" colSpan={2} className="px-3 py-1 text-center font-semibold">Opening</th>
              <th scope="colgroup" colSpan={2} className="px-3 py-1 text-center font-semibold">Movement</th>
              <th scope="colgroup" colSpan={2} className="px-3 py-1 text-center font-semibold">Closing</th>
            </tr>
            <tr>{COLUMNS.map((c) => <th key={c.key} scope="col" className="px-3 py-1 text-right font-semibold">{c.head}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.rows.map((r) => {
              const total = r.type !== 'posting';
              const cells = [r.openingDebit, r.openingCredit, r.debit, r.credit, r.closingDebit, r.closingCredit];
              return (
                <tr key={r.accountId} className={total ? 'bg-surface-sunken/60 font-bold' : ''}>
                  <th scope="row" className="px-3 py-2 text-left font-normal text-fg-strong" style={{ paddingLeft: `${String(12 + Math.min(r.indent, 4) * 12)}px` }}><span className="font-mono text-xs">{r.no}</span> <span className={total ? 'font-bold' : ''}>{r.name}</span></th>
                  {COLUMNS.map((c, i) => <td key={c.key} className="px-3 py-2 text-right tabular-nums">{cells[i] === '' || Number(cells[i]) === 0 ? '' : money(cells[i])}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data.rows.length === 0 ? <p className="text-sm text-fg-muted">Nothing was posted in this range.</p> : null}
    </div>
  );
}
