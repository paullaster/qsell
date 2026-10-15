'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { glEntriesAction } from '@/server/domains/finance/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { entriesArgs, type EntryFilter } from '@/lib/ledger-forms';
import { Field, LoadFailed, Message, PageHeader, buttonClass, cardClass, fieldClass, isZeroAmount, money, primaryClass, type Notice, attempt } from './ui';

type Page = Extract<Awaited<ReturnType<typeof glEntriesAction>>, { ok: true }>['data'];
type Row = Page['rows'][number];

export function EntriesClient({ initialPromise }: { initialPromise: ReturnType<typeof glEntriesAction> }) {
  const res = use(initialPromise);
  return res.ok ? <EntriesView initial={res.data} /> : <LoadFailed error={res.error} />;
}

function EntriesView({ initial }: { initial: Page }) {
  const uid = useId();
  const [rows, setRows] = useState<Row[]>(initial.rows);
  const [next, setNext] = useState(initial.next);
  const [filter, setFilter] = useState<EntryFilter>({ account: null, from: '', to: '', documentNo: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const apply = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const res = await attempt(glEntriesAction(entriesArgs(filter)));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setRows(res.data.rows);
    setNext(res.data.next);
  };
  const more = async () => {
    if (next === null) return;
    setBusy(true);
    const res = await attempt(glEntriesAction(entriesArgs(filter, next)));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setRows((r) => [...r, ...res.data.rows]);
    setNext(res.data.next);
  };

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader title="General ledger entries" intro="Every posted line, newest first. These rows are permanent: the database refuses to change or delete them." />
      <form onSubmit={(e) => void apply(e)} className={`${cardClass} grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5`} aria-label="Filter entries">
        <ChoicePicker label="Account" source="gl-accounts" choice={filter.account} onChoice={(account) => setFilter({ ...filter, account })} placeholder="All accounts" />
        <Field id={`${uid}-from`} label="From"><input id={`${uid}-from`} type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} className={fieldClass} /></Field>
        <Field id={`${uid}-to`} label="To"><input id={`${uid}-to`} type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} className={fieldClass} /></Field>
        <Field id={`${uid}-doc`} label="Document no."><input id={`${uid}-doc`} value={filter.documentNo} onChange={(e) => setFilter({ ...filter, documentNo: e.target.value })} className={`${fieldClass} font-mono`} autoComplete="off" /></Field>
        <div className="flex items-end"><button type="submit" disabled={busy} className={primaryClass}>Apply filter</button></div>
      </form>
      <Message notice={notice} />

      <ul className="space-y-2 md:hidden" aria-label="Entries">
        {rows.map((r) => (
          <li key={r.id} className="rounded-xl border border-line bg-surface-raised p-3 text-sm">
            <div className="flex justify-between gap-2"><span className="text-xs text-fg-muted">{r.postingDate}</span><span className="font-mono text-xs">{r.documentNo}</span></div>
            <p className="mt-1 text-fg-strong"><span className="font-mono text-xs">{r.accountNo}</span> {r.accountName}</p>
            <p className="mt-1 text-right tabular-nums">{isZeroAmount(r.debit) ? `Cr ${money(r.credit)}` : `Dr ${money(r.debit)}`} <span className="text-xs text-fg-muted">{r.currency}</span></p>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-xl border border-line md:block">
        <table className="w-full min-w-[46rem] text-left text-sm">
          <caption className="sr-only">General ledger entries</caption>
          <thead className="bg-surface-sunken text-xs text-fg-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-semibold">Date</th>
              <th scope="col" className="px-3 py-2 font-semibold">Document</th>
              <th scope="col" className="px-3 py-2 font-semibold">Account</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">Debit</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">Credit</th>
              <th scope="col" className="px-3 py-2 font-semibold">Cur.</th>
              <th scope="col" className="px-3 py-2 font-semibold"><span className="sr-only">Posting</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-hover">
                <td className="whitespace-nowrap px-3 py-2 text-xs text-fg-muted">{r.postingDate}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.documentNo}</td>
                <td className="px-3 py-2"><span className="font-mono text-xs">{r.accountNo}</span> {r.accountName}{r.description === null || r.description === '' ? null : <span className="block text-xs text-fg-muted">{r.description}</span>}</td>
                <td className="px-3 py-2 text-right tabular-nums">{isZeroAmount(r.debit) ? '' : money(r.debit)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{isZeroAmount(r.credit) ? '' : money(r.credit)}</td>
                <td className="px-3 py-2 text-xs text-fg-muted">{r.currency}</td>
                <td className="px-3 py-2 text-right"><Link href="/admin/finance/registers" className="text-xs text-indigo-600 hover:underline" aria-label={`Open the posting for ${r.documentNo}`}>Posting</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 ? <p className="text-sm text-fg-muted">Nothing matches.</p> : null}
      {next === null ? null : <button type="button" className={buttonClass} onClick={() => void more()} disabled={busy}>{busy ? 'Loading…' : 'Load more'}</button>}
    </div>
  );
}
