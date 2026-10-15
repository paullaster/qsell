'use client';

import Link from 'next/link';
import { use } from 'react';
import type { bankStatementsOverviewAction } from '@/server/domains/finance/bank-statement-actions';
import { plural, toDealWith } from '@/lib/bank-statement';
import { Chip, LoadFailed, PageHeader, cardClass, buttonClass, money } from './ui';

type View = Extract<Awaited<ReturnType<typeof bankStatementsOverviewAction>>, { ok: true }>['data'];

export function BankStatementsClient({ viewPromise }: { viewPromise: ReturnType<typeof bankStatementsOverviewAction> }) {
  const res = use(viewPromise);
  return res.ok ? <BankStatementsView view={res.data} /> : <LoadFailed error={res.error} />;
}

/** The chip on an account's card: the most pressing thing about it. */
function AccountChip({ blocked, toDo, lastImport }: { blocked: boolean; toDo: number; lastImport: string | null }) {
  if (blocked) return <Chip tone="red">Blocked</Chip>;
  if (toDo > 0) return <Chip tone="amber">{toDo} to deal with</Chip>;
  return lastImport === null ? <Chip tone="gray">No statement yet</Chip> : <Chip tone="green">Up to date</Chip>;
}

function BankStatementsView({ view }: { view: View }) {
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Bank statements"
        intro="Bring in what the bank says, match each line to what we recorded, and close the month when the two agree to the cent."
      />
      {view.rows.length === 0 ? <p className="text-sm text-fg-muted">There are no bank, cash or mobile-money accounts yet (Finance → Bank accounts).</p> : null}
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {view.rows.map((r) => {
          const toDo = toDealWith(r);
          return (
            <li key={r.id}>
              <Link href={`/admin/finance/bank-statements/${r.id}`} className={`${cardClass} block min-h-10 space-y-2 hover:bg-hover`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-sm font-bold text-fg-strong">{r.code} <span className="font-normal text-fg-muted">· {r.name}</span></p>
                  <AccountChip blocked={r.blocked} toDo={toDo} lastImport={r.last_import} />
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <div><dt className="text-fg-muted">In our books</dt><dd className="font-semibold tabular-nums text-fg-strong">{r.currency} {money(r.book)}</dd></div>
                  <div><dt className="text-fg-muted">Last statement line</dt><dd className="font-semibold text-fg-strong">{r.last_import ?? '—'}</dd></div>
                  <div><dt className="text-fg-muted">Ours, not on a statement</dt><dd className="font-semibold text-fg-strong">{r.outstanding}</dd></div>
                  <div><dt className="text-fg-muted">Last reconciled</dt><dd className="font-semibold text-fg-strong">{r.last_rec_date === null ? 'Never' : `${r.last_rec_date} (${money(r.last_rec_balance)})`}</dd></div>
                </dl>
                {r.matched_open > 0 ? <p className="text-xs text-fg-muted">{r.matched_open} dealt-with {plural(r.matched_open, 'line', 'lines')} waiting to be reconciled</p> : null}
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-fg-muted">
        <Link className={buttonClass} href="/admin/finance/bank-accounts">Bank accounts</Link>
      </p>
    </div>
  );
}
