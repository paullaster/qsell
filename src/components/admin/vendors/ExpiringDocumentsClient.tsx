'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { expiringDocumentsAction } from '@/server/domains/vendors/admin-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import type { Choice } from '@/lib/payment-options';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, type Notice } from '@/components/ui/screen-kit';

type Page = Extract<Awaited<ReturnType<typeof expiringDocumentsAction>>, { ok: true }>['data'];
type Row = Page['rows'][number];

export function ExpiringDocumentsClient({ initialPromise }: { initialPromise: ReturnType<typeof expiringDocumentsAction> }) {
  const res = use(initialPromise);
  return res.ok ? <ExpiringView initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Timing({ row }: { row: Row }) {
  if (row.status === 'expired' || row.daysLeft < 0) return <Chip tone="red">Expired {row.expiresOn}</Chip>;
  if (row.daysLeft <= 7) return <Chip tone="red">{row.daysLeft === 0 ? 'Expires today' : `${String(row.daysLeft)} days left`}</Chip>;
  return <Chip tone={row.daysLeft <= 30 ? 'amber' : 'gray'}>{row.daysLeft} days left</Chip>;
}

function ExpiringView({ initial }: { initial: Page }) {
  const [rows, setRows] = useState<Row[]>(initial.rows);
  const [next, setNext] = useState(initial.next);
  const [window, setWindow] = useState<Choice>({ id: '60', label: 'Within 60 days' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = async (days: string, before: Page['next'], append: boolean) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(expiringDocumentsAction({ withinDays: Number(days), before }));
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
      <PageHeader title="Expiring vendor documents" intro="Documents that have expired or are about to, soonest first. Vendors are reminded automatically; chase the ones that matter." actions={<Link href="/admin/vendors" className="text-sm font-semibold text-indigo-600 hover:underline">All vendors</Link>} />
      <div className={`${cardClass} max-w-xs`}>
        <ChoicePicker label="Show" source="vendor-expiry-windows" choice={window} onChoice={(c) => { if (c !== null) { setWindow(c); void load(c.id, null, false); } }} clearable={false} />
      </div>
      <Message notice={notice} />
      {rows.length === 0 ? <p className="text-sm text-fg-muted">Nothing expires in this window.</p> : (
        <ul className="space-y-2" aria-label="Expiring documents">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={`/admin/vendors/${r.vendorId}`} className={`${cardClass} flex min-h-10 flex-wrap items-center justify-between gap-2 hover:bg-hover`}>
                <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{r.vendorName}{r.vendorNumber === null ? '' : ` · ${r.vendorNumber}`}</span><span className="block text-xs text-fg-muted">{r.typeName}{r.blocking ? ' · blocks the vendor when it expires' : ''}</span></span>
                <Timing row={r} />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {next !== null ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void load(window.id, next, true)}>Show more</button> : null}
    </div>
  );
}
