'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { deliveriesPageAction } from '@/server/domains/delivery/document-actions';
import type { DeliveryListItem } from '@/server/domains/delivery/documents';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, PageHeader, buttonClass, cardClass, fieldClass } from '@/components/ui/screen-kit';
import { usePagedList } from '@/components/ui/usePagedList';
import type { Choice } from '@/lib/payment-options';
import { METHOD_WORDS } from '@/lib/delivery-methods';
import type { DeliveryStatus } from '@/lib/delivery-document';

const TONE: Record<DeliveryStatus, 'green' | 'amber' | 'red' | 'sky' | 'gray'> = {
  draft: 'gray',
  released: 'sky',
  picking: 'sky',
  packed: 'sky',
  ready: 'amber',
  out_for_delivery: 'amber',
  delivered: 'green',
  failed_attempt: 'red',
  returned: 'red',
  cancelled: 'gray',
};

const made = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });

/** The deliveries of orders, newest first, by state or by what is typed, a page at a time. Each opens its own screen. */
export function DeliveriesClient() {
  const uid = useId();
  const [status, setStatus] = useState<Choice | null>(null);
  const [query, setQuery] = useState('');

  const list = usePagedList<DeliveryListItem, { status: string; query: string }>({
    load: async (filters, cursor) => {
      const result = await deliveriesPageAction({ status: filters.status, query: filters.query, cursor });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, data: { rows: result.data.rows, nextCursor: result.data.nextCursor } };
    },
    filters: { status: status?.id ?? '', query: query.trim() },
  });

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader title="Deliveries" intro="What is being got ready and sent to customers. Make a delivery from an order; it can carry all of the order or only what is ready, and the rest goes on another." />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[16rem_1fr]">
        <ChoicePicker label="State" source="delivery-statuses" choice={status} onChoice={setStatus} placeholder="All states" clearable />
        <div>
          <label htmlFor={`${uid}-search`} className="mb-1 block text-xs font-semibold text-fg-muted">
            Search
          </label>
          <input id={`${uid}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Delivery number, order number or customer" className={fieldClass} autoComplete="off" />
        </div>
      </div>

      {list.phase === 'error' ? (
        <p role="alert" className="text-sm text-red-700">
          {list.error}{' '}
          <button type="button" className={buttonClass} onClick={list.retry}>
            Try again
          </button>
        </p>
      ) : null}
      {list.phase === 'loading' ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading deliveries…
        </p>
      ) : null}
      {list.phase !== 'loading' && list.phase !== 'error' && list.rows.length === 0 ? (
        <p role="status" className="rounded-xl border border-line bg-surface-raised p-8 text-center text-sm text-fg-muted">
          {status !== null || query.trim() !== '' ? 'No delivery matches.' : 'No deliveries yet. Open an order that is to be delivered and make one.'}
        </p>
      ) : null}

      {list.rows.length === 0 ? null : (
        <>
          {/* A phone gets cards; a wider screen gets a table. */}
          <ul className="space-y-3 md:hidden" aria-label="Deliveries">
            {list.rows.map((row) => (
              <li key={row.id} className={`${cardClass} space-y-1.5`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/admin/delivery/deliveries/${row.id}`} className="min-h-10 py-2 font-mono text-sm font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
                    {row.number}
                  </Link>
                  <Chip tone={TONE[row.status]}>{row.statusWords}</Chip>
                </div>
                <p className="text-sm text-fg-strong">{row.customerName}</p>
                <p className="text-xs text-fg-muted">
                  Order {row.orderNumber} · {METHOD_WORDS[row.method].name} · from {row.branchName}
                </p>
                <p className="text-xs text-fg-muted">
                  {row.lineCount} {row.lineCount === 1 ? 'product' : 'products'} · made {made(row.createdAt)}
                </p>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto rounded-xl border border-line md:block">
            <table className="w-full text-left text-sm" aria-label="Deliveries">
              <thead className="border-b border-line bg-surface text-xs tracking-wider text-fg-muted uppercase">
                <tr>
                  <th scope="col" className="px-4 py-3">Delivery</th>
                  <th scope="col" className="px-4 py-3">Order</th>
                  <th scope="col" className="px-4 py-3">Customer</th>
                  <th scope="col" className="px-4 py-3">How</th>
                  <th scope="col" className="px-4 py-3">From</th>
                  <th scope="col" className="px-4 py-3">State</th>
                  <th scope="col" className="px-4 py-3">Made</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/80">
                {list.rows.map((row) => (
                  <tr key={row.id} className="hover:bg-hover">
                    <td className="px-4 py-3">
                      <Link href={`/admin/delivery/deliveries/${row.id}`} className="font-mono font-semibold text-indigo-600 hover:underline dark:text-indigo-400">
                        {row.number}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{row.orderNumber}</td>
                    <td className="px-4 py-3">{row.customerName}</td>
                    <td className="px-4 py-3 text-xs">{METHOD_WORDS[row.method].name}</td>
                    <td className="px-4 py-3 text-xs">{row.branchName}</td>
                    <td className="px-4 py-3">
                      <Chip tone={TONE[row.status]}>{row.statusWords}</Chip>
                    </td>
                    <td className="px-4 py-3 text-xs text-fg-muted">{made(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {list.cursor !== null ? (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}
