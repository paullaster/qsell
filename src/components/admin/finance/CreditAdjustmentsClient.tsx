'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { listCreditAdjustmentsAction } from '@/server/domains/finance/credit-adjustment-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { ADJUSTMENT_KIND, ADJUSTMENT_STATUS, statusInfo } from '@/lib/finance-statuses';
import { adjustmentRoute } from '@/lib/credit-adjustment-form';
import type { Choice } from '@/lib/payment-options';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, money, primaryClass, type Notice } from './ui';

type Page = Extract<Awaited<ReturnType<typeof listCreditAdjustmentsAction>>, { ok: true }>['data'];

export function CreditAdjustmentsClient({ initialPromise }: { initialPromise: ReturnType<typeof listCreditAdjustmentsAction> }) {
  const res = use(initialPromise);
  return res.ok ? <CreditAdjustmentsView initial={res.data} /> : <LoadFailed error={res.error} />;
}

function CreditAdjustmentsView({ initial }: { initial: Page }) {
  const [rows, setRows] = useState(initial.rows);
  const [next, setNext] = useState(initial.nextBefore);
  const [status, setStatus] = useState<Choice | null>(null);
  const [kind, setKind] = useState<Choice | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = async (more: boolean) => {
    setBusy(true);
    const query = q.trim();
    const res = await attempt(listCreditAdjustmentsAction({
      status: (status?.id ?? undefined) as never,
      kind: (kind?.id ?? undefined) as never,
      q: query === '' ? undefined : query,
      before: more ? (next ?? undefined) : undefined,
    }));
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setNotice(null);
    setRows(more ? [...rows, ...res.data.rows] : res.data.rows);
    setNext(res.data.nextBefore);
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Customer credit adjustments"
        intro="Giving up credit a customer is owed, adding to or taking from a wallet, and balances that lapsed. One person asks, another decides, and every change is kept with who, why and when."
        actions={initial.can.request ? <Link href="/admin/finance/receivables/credit-adjustments/new" className={primaryClass}>New adjustment</Link> : null}
      />
      <Message notice={notice} />
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void load(false); }} role="search">
        <div className="min-w-48"><ChoicePicker label="State" source="adjustment-statuses" choice={status} onChoice={setStatus} placeholder="All" /></div>
        <div className="min-w-48"><ChoicePicker label="What it does" source="adjustment-kinds" choice={kind} onChoice={setKind} placeholder="All" /></div>
        <label className="min-w-40 flex-1 text-xs font-semibold text-fg-muted">Search
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Number or customer" className={`${fieldClass} mt-1 block w-full`} autoComplete="off" />
        </label>
        <button type="submit" className={buttonClass} disabled={busy}>Show</button>
      </form>
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">No adjustments match.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={adjustmentRoute(r.id)} className={`${cardClass} block min-h-10 hover:bg-hover`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-sm font-bold text-fg-strong">{r.number} <span className="font-normal text-fg-muted">· {r.customer}</span></p>
                  <span className="flex items-center gap-2"><Chip tone={statusInfo(ADJUSTMENT_KIND, r.kind).tone}>{statusInfo(ADJUSTMENT_KIND, r.kind).label}</Chip><Chip tone={statusInfo(ADJUSTMENT_STATUS, r.status).tone}>{statusInfo(ADJUSTMENT_STATUS, r.status).label}</Chip></span>
                </div>
                <p className="mt-1 text-xs text-fg-muted">{r.currency} {money(r.amount)} · {r.reason.replace(/_/g, ' ')} · {new Date(r.createdAt).toLocaleDateString()}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {next !== null ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void load(true)}>Show more</button> : null}
    </div>
  );
}
