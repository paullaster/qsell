'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { vendorOrdersAction } from '@/server/domains/vendors/po-portal-actions';
import { PO_STATUS } from '@/lib/purchase-order';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, type Notice } from '@/components/ui/screen-kit';

type Page = Extract<Awaited<ReturnType<typeof vendorOrdersAction>>, { ok: true }>['data'];

export function OrdersListClient({ initialPromise }: { initialPromise: ReturnType<typeof vendorOrdersAction> }) {
  const res = use(initialPromise);
  return res.ok ? <ListView initial={res.data} /> : <LoadFailed error={res.error} />;
}

function ListView({ initial }: { initial: Page }) {
  const [rows, setRows] = useState(initial.rows);
  const [next, setNext] = useState(initial.next);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const more = async () => {
    if (next === null) return;
    setBusy(true);
    const res = await attempt(vendorOrdersAction(next));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setRows((r) => [...r, ...res.data.rows]);
    setNext(res.data.next);
  };
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Purchase orders" intro="Orders sent to you. Confirm each one to accept it." actions={<Link href="/vendor" className={buttonClass}>Back</Link>} />
      <Message notice={notice} />
      {rows.length === 0 ? <p className="text-sm text-fg-muted">You have no purchase orders yet.</p> : (
        <ul className="space-y-2" aria-label="Orders">
          {rows.map((r) => {
            const s = PO_STATUS[r.status] ?? { label: r.status, tone: 'gray' as const };
            return (
              <li key={r.id}>
                <Link href={`/vendor/orders/${r.id}`} className={`${cardClass} flex min-h-10 flex-wrap items-center justify-between gap-2 hover:bg-hover`}>
                  <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{r.number ?? ''}</span><span className="block text-xs text-fg-muted">{r.total} {r.currency}{r.expectedDate === null ? '' : ` · expected ${r.expectedDate}`}{r.version > 1 ? ` · version ${String(r.version)}` : ''}</span></span>
                  <span className="flex items-center gap-2">{r.needsConfirmation ? <Chip tone="amber">Please confirm</Chip> : null}<Chip tone={s.tone}>{s.label}</Chip></span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {next === null ? null : <button type="button" className={buttonClass} disabled={busy} onClick={() => void more()}>Show older orders</button>}
    </div>
  );
}
