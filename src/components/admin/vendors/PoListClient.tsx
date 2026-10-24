'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { poListAction } from '@/server/domains/vendors/po-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { PO_STATUS } from '@/lib/purchase-order';
import type { Choice } from '@/lib/payment-options';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Page = Extract<Awaited<ReturnType<typeof poListAction>>, { ok: true }>['data'];
type Row = Page['rows'][number];

export function PoListClient({ initialPromise }: { initialPromise: ReturnType<typeof poListAction> }) {
  const res = use(initialPromise);
  return res.ok ? <ListView initial={res.data} /> : <LoadFailed error={res.error} />;
}

function ListView({ initial }: { initial: Page }) {
  const [rows, setRows] = useState<Row[]>(initial.rows);
  const [next, setNext] = useState(initial.next);
  const [status, setStatus] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const load = async (s: Choice | null, before: Page['next'], append: boolean) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(poListAction({ status: s?.id, before }));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setRows((r) => (append ? [...r, ...res.data.rows] : res.data.rows));
    setNext(res.data.next);
  };
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Purchase orders" intro="What you have ordered from vendors. An order is approved by someone other than the person who wrote it, then sent to the vendor to confirm." actions={initial.can.create ? <Link href="/admin/vendors/orders/new" className={primaryClass}>New order</Link> : null} />
      <div className={`${cardClass} max-w-xs`}><ChoicePicker label="Status" source="po-statuses" choice={status} onChoice={(c) => { setStatus(c); void load(c, null, false); }} placeholder="All" /></div>
      <Message notice={notice} />
      {rows.length === 0 ? <p className="text-sm text-fg-muted">No purchase orders yet.</p> : (
        <ul className="space-y-2" aria-label="Purchase orders">
          {rows.map((r) => {
            const s = PO_STATUS[r.status] ?? { label: r.status, tone: 'gray' as const };
            return (
              <li key={r.id}>
                <Link href={`/admin/vendors/orders/${r.id}`} className={`${cardClass} flex min-h-10 flex-wrap items-center justify-between gap-2 hover:bg-hover`}>
                  <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{r.number ?? 'Draft'} · {r.vendorName}</span><span className="block text-xs text-fg-muted">{r.total} {r.currency}{r.version > 1 ? ` · version ${String(r.version)}` : ''}</span></span>
                  <Chip tone={s.tone}>{s.label}</Chip>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {next !== null ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void load(status, next, true)}>Show more</button> : null}
    </div>
  );
}
