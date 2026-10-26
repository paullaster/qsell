'use client';

import Link from 'next/link';
import { use } from 'react';
import type { requisitionsAction } from '@/server/domains/vendors/requisition-actions';
import { REQUISITION_STATUS } from '@/lib/purchase-requisition';
import { Chip, LoadFailed, PageHeader, primaryClass } from '@/components/ui/screen-kit';

type Data = Extract<Awaited<ReturnType<typeof requisitionsAction>>, { ok: true }>['data'];

export function RequisitionListClient({ initialPromise }: { initialPromise: ReturnType<typeof requisitionsAction> }) {
  const res = use(initialPromise);
  return res.ok ? <List data={res.data} /> : <LoadFailed error={res.error} />;
}

function List({ data }: { data: Data }) {
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title="Purchase requisitions" intro="Requests to buy something. Another person approves; an approved one becomes a request for quotation or an order." actions={data.can.create ? <Link href="/admin/vendors/requisitions/new" className={primaryClass}>New requisition</Link> : undefined} />
      {data.rows.length === 0 ? <p className="text-sm text-fg-muted">There are no requisitions yet.</p> : (
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Requisitions">
          {data.rows.map((r) => {
            const s = REQUISITION_STATUS[r.status];
            return (
              <li key={r.id}>
                <Link href={`/admin/vendors/requisitions/${r.id}`} className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-3 py-2 hover:bg-hover">
                  <span className="min-w-0 text-sm text-fg"><span className="font-semibold">{r.number ?? 'Draft'}</span> · {r.title}<span className="block text-xs text-fg-muted">{r.category} · asked by {r.requester ?? 'someone'}{r.neededBy === null ? '' : ` · needed by ${r.neededBy}`}</span></span>
                  <span className="flex items-center gap-2"><span className="text-sm font-semibold tabular-nums">{r.estimatedTotal} {r.currency}</span><Chip tone={s.tone}>{s.label}</Chip></span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
