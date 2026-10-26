'use client';

import Link from 'next/link';
import { use } from 'react';
import type { returnsAction } from '@/server/domains/vendors/purchase-return-actions';
import { RETURN_REASONS, RETURN_STATUS } from '@/lib/purchase-return';
import { Chip, LoadFailed, PageHeader, buttonClass } from '@/components/ui/screen-kit';

type Data = Extract<Awaited<ReturnType<typeof returnsAction>>, { ok: true }>['data'];

export function ReturnListClient({ initialPromise }: { initialPromise: ReturnType<typeof returnsAction> }) {
  const res = use(initialPromise);
  return res.ok ? <List data={res.data} /> : <LoadFailed error={res.error} />;
}

function List({ data }: { data: Data }) {
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title="Goods sent back to vendors" intro="Goods taken out of stock and returned after they were received. To start one, open the received goods note and choose “Send goods back to the vendor”." actions={<Link href="/admin/vendors/receipts" className={buttonClass}>Received goods</Link>} />
      {data.rows.length === 0 ? <p className="text-sm text-fg-muted">Nothing has been sent back.</p> : (
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Returns">
          {data.rows.map((r) => {
            const s = RETURN_STATUS[r.status];
            return (
              <li key={r.id}>
                <Link href={`/admin/vendors/returns/${r.id}`} className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-3 py-2 hover:bg-hover">
                  <span className="min-w-0 text-sm text-fg"><span className="font-semibold">{r.number ?? 'Not posted yet'}</span> · {r.vendor}<span className="block text-xs text-fg-muted">From {r.note ?? 'a note'} · {r.returnDate} · {RETURN_REASONS.find((x) => x.id === r.reason)?.label ?? r.reason}</span></span>
                  <Chip tone={s.tone}>{s.label}</Chip>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
