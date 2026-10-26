'use client';

import Link from 'next/link';
import { use } from 'react';
import type { landedCostsAction } from '@/server/domains/vendors/landed-cost-actions';
import { LANDED_KINDS, LANDED_STATUS } from '@/lib/landed-cost';
import { Chip, LoadFailed, PageHeader, buttonClass } from '@/components/ui/screen-kit';

type Data = Extract<Awaited<ReturnType<typeof landedCostsAction>>, { ok: true }>['data'];

export function LandedCostListClient({ initialPromise }: { initialPromise: ReturnType<typeof landedCostsAction> }) {
  const res = use(initialPromise);
  return res.ok ? <List data={res.data} /> : <LoadFailed error={res.error} />;
}

function List({ data }: { data: Data }) {
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title="Landed costs" intro="Freight, duty and similar charges added to what received goods cost. To start one, open the received goods note and choose “Add a freight, duty or other charge”." actions={<Link href="/admin/vendors/receipts" className={buttonClass}>Received goods</Link>} />
      {data.rows.length === 0 ? <p className="text-sm text-fg-muted">No charges have been added to goods.</p> : (
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Landed costs">
          {data.rows.map((r) => {
            const s = LANDED_STATUS[r.status];
            return (
              <li key={r.id}>
                <Link href={`/admin/vendors/landed-costs/${r.id}`} className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-3 py-2 hover:bg-hover">
                  <span className="min-w-0 text-sm text-fg"><span className="font-semibold">{r.number ?? 'Not posted yet'}</span> · {LANDED_KINDS.find((k) => k.id === r.kind)?.label ?? r.kind} · {r.description}<span className="block text-xs text-fg-muted">On {r.note ?? 'a note'} from {r.vendor} · {r.reference}</span></span>
                  <span className="flex items-center gap-2"><span className="text-sm font-semibold tabular-nums">{r.amount}</span><Chip tone={s.tone}>{s.label}</Chip></span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
