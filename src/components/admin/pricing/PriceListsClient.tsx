'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  createPriceListAction,
  type PriceListView,
  type PricingLookups,
} from '@/server/domains/pricing/actions';
import {
  Chip,
  EmptyState,
  PageHeader,
  StatusChip,
  cardClass,
  primaryButtonClass,
  When,
} from '../approvals/shared';
import { PriceListForm } from './PriceListForm';

export function listStatusChip(l: Pick<PriceListView, 'status' | 'approvalStatus'>) {
  if (l.approvalStatus === 'pending') return <StatusChip status="pending" />;
  if (l.status === 'active') return <Chip tone="green">In force</Chip>;
  if (l.status === 'retired') return <StatusChip status="retired" />;
  return <Chip tone="sky">Draft</Chip>;
}

export function PriceListsClient({
  lists,
  lookups,
  canManage,
}: {
  lists: PriceListView[];
  lookups: PricingLookups;
  canManage: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Price lists"
        actions={
          canManage && !creating ? (
            <button type="button" className={primaryButtonClass} onClick={() => setCreating(true)}>
              New price list
            </button>
          ) : null
        }
      >
        Prices for a customer, a group, a branch or a channel. When several lists could price the
        same sale, the most specific one wins; a product in none of them is sold at its standard
        price.
      </PageHeader>

      {creating ? (
        <section aria-labelledby="new-list" className={cardClass}>
          <h3 id="new-list" className="mb-3 text-sm font-bold text-fg-strong">
            New price list
          </h3>
          <PriceListForm
            mode="create"
            lookups={lookups}
            names={{}}
            submitLabel="Create as draft"
            onCancel={() => setCreating(false)}
            onSubmit={async (values, reason) => {
              const r = await createPriceListAction(values, reason);
              if (r.ok) router.push(`/admin/pricing/lists/${r.data.id}`);
              return r.ok ? { ok: true } : { ok: false, error: r.error, issues: r.issues };
            }}
          />
        </section>
      ) : null}

      {lists.length === 0 ? (
        <EmptyState title="No price lists yet">
          Everything is sold at its standard price. Create a list to give a customer, group or
          branch its own prices.
        </EmptyState>
      ) : (
        <div className={`${cardClass} overflow-x-auto p-0 sm:p-0`}>
          <table className="w-full min-w-[44rem] text-left text-sm">
            <caption className="sr-only">Price lists</caption>
            <thead className="border-b border-line text-xs text-fg-muted">
              <tr>
                <th scope="col" className="px-4 py-3">
                  List
                </th>
                <th scope="col" className="px-4 py-3">
                  Applies to
                </th>
                <th scope="col" className="px-4 py-3">
                  Status
                </th>
                <th scope="col" className="px-4 py-3 text-right">
                  Prices
                </th>
                <th scope="col" className="px-4 py-3">
                  Changed
                </th>
              </tr>
            </thead>
            <tbody>
              {lists.map((l) => (
                <tr key={l.id} className="border-b border-line last:border-0">
                  <th scope="row" className="px-4 py-3 align-top">
                    <Link
                      href={`/admin/pricing/lists/${l.id}`}
                      className="inline-flex min-h-10 items-center font-semibold text-indigo-700 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500"
                    >
                      {l.name}
                    </Link>
                    <div className="text-xs font-normal text-fg-muted">
                      {l.code} · {l.currency}
                      {l.kind === 'contract' ? ' · contract' : ''} · priority {l.priority}
                    </div>
                  </th>
                  <td className="max-w-xs px-4 py-3 align-top text-fg">{l.scopeText}</td>
                  <td className="px-4 py-3 align-top">{listStatusChip(l)}</td>
                  <td className="px-4 py-3 text-right align-top tabular-nums">
                    {l.lineCount.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 align-top text-xs text-fg-muted">
                    <When iso={l.updatedAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
