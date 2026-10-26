'use client';

import Link from 'next/link';
import { use } from 'react';
import type { contractsAction } from '@/server/domains/vendors/contract-actions';
import { CONTRACT_STATUS } from '@/lib/vendor-contract';
import { Chip, LoadFailed, PageHeader, primaryClass } from '@/components/ui/screen-kit';

type Data = Extract<Awaited<ReturnType<typeof contractsAction>>, { ok: true }>['data'];

export function ContractListClient({ initialPromise }: { initialPromise: ReturnType<typeof contractsAction> }) {
  const res = use(initialPromise);
  return res.ok ? <List data={res.data} /> : <LoadFailed error={res.error} />;
}

function List({ data }: { data: Data }) {
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title="Vendor contracts" intro="Agreed prices for a period, with limits. Orders are called off a contract at its prices." actions={data.can.create ? <Link href="/admin/vendors/contracts/new" className={primaryClass}>New contract</Link> : undefined} />
      {data.rows.length === 0 ? <p className="text-sm text-fg-muted">There are no contracts yet.</p> : (
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Contracts">
          {data.rows.map((r) => {
            const s = CONTRACT_STATUS[r.status];
            return (
              <li key={r.id}>
                <Link href={`/admin/vendors/contracts/${r.id}`} className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-3 py-2 hover:bg-hover">
                  <span className="min-w-0 text-sm text-fg"><span className="font-semibold">{r.number ?? 'Draft'}</span> · {r.title}<span className="block text-xs text-fg-muted">{r.vendor} · {r.validFrom} to {r.validTo}{r.maxValue === null ? '' : ` · up to ${r.maxValue} ${r.currency}`}</span></span>
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
