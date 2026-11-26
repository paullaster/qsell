'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, Search, ShoppingBag } from 'lucide-react';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { usePagedList, type PageResult } from '@/components/ui/usePagedList';
import { useDebouncedValue } from '@/components/ui/useDebouncedValue';
import { buttonClass, fieldClass } from '@/components/ui/screen-kit';
import { ordersPageAction } from '@/server/domains/orders/actions';
import { orderHref } from '@/lib/order-links';
import { onOrdersChanged } from '@/lib/orders-changed';
import { money, unitsIn } from '@/lib/order-admin';
import { shownPaymentReference } from '@/lib/paymentReference';
import type { Choice } from '@/lib/payment-options';
import type { Order } from '@/types/index';
import { LeftAtCounterBadge, OrderStatusBadge } from './orders/OrderStatusBadge';
import { useWhen } from '@/components/business-time';

interface AdminOrdersProps {
  /** The first page, already on its way when the screen is drawn. */
  firstPage: Promise<PageResult<Order>>;
}

/** The orders, a page at a time: search, narrow by state, and open one to fulfil, invoice, take payment on or credit. */
export function AdminOrders({ firstPage }: AdminOrdersProps) {
  const when = useWhen();
  const first = use(firstPage);

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<Choice | null>(null);
  const [counter, setCounter] = useState<Choice | null>(null);
  const query = useDebouncedValue(search.trim());
  const list = usePagedList<Order, { query: string; status: string | null; counter: string | null }>({
    load: (filters, cursor) =>
      ordersPageAction({ query: filters.query, status: filters.status, counter: filters.counter, cursor }),
    filters: { query, status: status?.id ?? null, counter: counter?.id ?? null },
    initialPage: first,
  });

  // An order changed in the window that opened over this list: the rows are read again, so the list is never behind what was just done.
  useEffect(() => onOrdersChanged(list.reload), [list.reload]);
  const rows = list.rows;

  const reference = (o: Order) => shownPaymentReference(o);

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 rounded-xl border border-line bg-surface-raised p-5 sm:flex-row sm:items-center">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-fg-strong">
            <ShoppingBag className="h-5 w-5 text-indigo-400" aria-hidden />
            Web Shop Orders
          </h2>
          <p className="mt-0.5 text-xs text-fg-muted">
            Review orders customers placed through the web shop; assign courier tracking, print
            packing slips, and manage cancellations with automatic stock return.
          </p>
        </div>
        <button type="button" onClick={list.reload} className={`${buttonClass} w-fit gap-1`}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Refresh Orders
        </button>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface-raised p-4 text-xs sm:flex-row sm:items-end sm:justify-between">
        <div className="relative w-full sm:w-96">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <input
            type="search"
            aria-label="Search orders"
            placeholder="Search Order #, customer name, phone, tracking..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${fieldClass} pl-9`}
            autoComplete="off"
          />
        </div>
        <div className="w-full sm:w-64">
          <ChoicePicker
            label="Status"
            source="order-statuses"
            choice={status}
            onChoice={setStatus}
            placeholder="All statuses"
          />
        </div>
        <div className="w-full sm:w-64">
          <ChoicePicker
            label="Waiting at the counter"
            source="order-counter-waits"
            choice={counter}
            onChoice={setCounter}
            placeholder="Any wait"
          />
        </div>
      </div>

      {list.phase === 'error' && rows.length === 0 ? (
        <div
          role="alert"
          className="space-y-2 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800"
        >
          <p>{list.error}</p>
          <button type="button" className={buttonClass} onClick={list.retry}>
            Try again
          </button>
        </div>
      ) : null}
      {list.phase === 'loading' && rows.length === 0 ? (
        <p
          role="status"
          className="rounded-xl border border-line bg-surface-raised p-6 text-center text-sm text-fg-muted"
        >
          Loading orders…
        </p>
      ) : null}
      {list.phase !== 'loading' && list.phase !== 'error' && rows.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface-raised p-10 text-center text-sm text-fg-subtle">
          No orders match the current filter criteria.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <>
          <ul className="space-y-3 md:hidden" aria-label="Orders">
            {rows.map((o) => (
              <li
                key={o.id}
                className="space-y-3 rounded-xl border border-line bg-surface-raised p-4 text-xs"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-bold text-fg-strong">{o.orderNumber}</p>
                    <p className="text-[11px] text-fg-muted">
                      {when(o.createdAt)}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <OrderStatusBadge status={o.status} />
                    {o.leftAtCounterDays === undefined ? null : <LeftAtCounterBadge days={o.leftAtCounterDays} />}
                  </div>
                </div>
                <div>
                  <p className="font-semibold text-fg-strong">{o.customerName}</p>
                  <p className="font-mono text-[11px] text-fg-muted">{o.customerPhone}</p>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono font-bold text-fg-strong">
                    {money(o.totalAmount, o.currency)}
                  </span>
                  <span className="rounded bg-surface-sunken px-2 py-0.5 font-mono text-[10px] font-bold text-fg uppercase">
                    {o.paymentMethod}
                  </span>
                </div>
                <Link href={orderHref(o.id)} className={`${buttonClass} w-full`} aria-label={`Open order ${o.orderNumber}`}>
                  Open order
                </Link>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-hidden rounded-xl border border-line bg-surface-raised shadow-xl md:block">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-line bg-surface font-semibold text-fg-muted">
                <tr>
                  <th scope="col" className="px-4 py-3">
                    Order #
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Date
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Customer
                  </th>
                  <th scope="col" className="px-4 py-3 text-center">
                    Items
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    Total Amount
                  </th>
                  <th scope="col" className="px-4 py-3 text-center">
                    Payment Info
                  </th>
                  <th scope="col" className="px-4 py-3 text-center">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line text-fg">
                {rows.map((o) => (
                  <tr key={o.id} className="transition-colors hover:bg-hover">
                    <td className="px-4 py-3.5 font-mono font-bold text-fg-strong">
                      {o.orderNumber}
                    </td>
                    <td className="px-4 py-3.5 text-[11px] text-fg-muted">
                      {when(o.createdAt)}
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-fg-strong">{o.customerName}</div>
                      <div className="font-mono text-[11px] text-fg-muted">{o.customerPhone}</div>
                    </td>
                    <td className="px-4 py-3.5 text-center font-mono font-bold text-fg">
                      {unitsIn(o)}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono font-bold text-fg-strong">
                      {money(o.totalAmount, o.currency)}
                    </td>
                    <td className="px-4 py-3.5 text-center">
                      <div className="inline-flex flex-col items-center">
                        <span className="rounded bg-surface-sunken px-2 py-0.5 font-mono text-[10px] font-bold text-fg uppercase">
                          {o.paymentMethod}
                        </span>
                        {reference(o) === null ? null : (
                          <span
                            className="mt-0.5 max-w-[100px] truncate font-mono text-[9px] text-fg-subtle"
                            title={reference(o) ?? ''}
                          >
                            Ref: {reference(o)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-center">
                      <div className="flex flex-col items-center gap-1">
                        <OrderStatusBadge status={o.status} />
                        {o.leftAtCounterDays === undefined ? null : <LeftAtCounterBadge days={o.leftAtCounterDays} />}
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <Link href={orderHref(o.id)} className={buttonClass} aria-label={`Open order ${o.orderNumber}`}>
                        Open order
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {list.cursor === null ? null : (
            <div className="flex justify-center">
              <button
                type="button"
                className={buttonClass}
                disabled={list.phase === 'more'}
                onClick={list.loadMore}
              >
                {list.phase === 'more' ? 'Loading…' : 'Show more orders'}
              </button>
            </div>
          )}
          {list.phase === 'error' ? (
            <p role="alert" className="text-center text-sm text-red-700">
              {list.error}{' '}
              <button type="button" className="underline" onClick={list.retry}>
                Try again
              </button>
            </p>
          ) : null}
        </>
      ) : null}

    </div>
  );
}
