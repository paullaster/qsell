'use client';

import { use } from 'react';
import Link from 'next/link';
import { ChevronRight, Package } from 'lucide-react';
import { Chip, LoadFailed } from '@/components/ui/screen-kit';
import { usePagedList, type PageResult } from '@/components/ui/usePagedList';
import { myOrdersPageAction, type AccountResult } from '@/server/domains/customers/actions';
import {
  formatAmount,
  formatOrderDate,
  itemCountLabel,
  orderStateOf,
  paymentStateOf,
  type CustomerOrder,
} from '@/lib/storefront-account';
import { SignInPrompt } from './SignInPrompt';

interface Page {
  rows: CustomerOrder[];
  nextCursor: string | null;
}

const loadPage = (_: object, cursor: string | null): Promise<PageResult<CustomerOrder>> =>
  myOrdersPageAction({ cursor });

export function OrdersClient({ firstPage }: { firstPage: Promise<AccountResult<Page>> }) {
  const first = use(firstPage);
  if (!first.ok && first.code === 'SIGN_IN') return <SignInPrompt what="your orders" />;
  return <OrderList first={first} />;
}

function OrderList({ first }: { first: AccountResult<Page> }) {
  const list = usePagedList<CustomerOrder, object>({
    load: loadPage,
    filters: {},
    initialPage: first,
  });
  if (list.phase === 'error') {
    return (
      <div className="space-y-3">
        <LoadFailed error={list.error ?? 'Your orders could not be loaded.'} />
        <button
          type="button"
          onClick={list.retry}
          className="min-h-10 rounded-lg border border-line px-4 text-sm font-medium hover:bg-hover"
        >
          Try again
        </button>
      </div>
    );
  }
  if (list.phase === 'loading' && list.rows.length === 0) {
    return (
      <p role="status" className="text-sm text-fg-muted">
        Loading your orders…
      </p>
    );
  }
  if (list.rows.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-surface-raised p-8 text-center">
        <Package className="mx-auto h-10 w-10 text-fg-subtle" aria-hidden="true" />
        <p className="mt-3 font-medium text-fg-strong">You have not placed an order yet.</p>
        <p className="mt-1 text-sm text-fg-muted">
          Orders you place show up here, with their delivery progress.
        </p>
        <Link
          href="/"
          className="mt-4 inline-flex min-h-10 items-center rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
        >
          Start shopping
        </Link>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <ul className="space-y-3" aria-label="Your orders">
        {list.rows.map((order) => {
          const state = orderStateOf(order.status);
          const payment = paymentStateOf(order.paymentStatus);
          return (
            <li key={order.id}>
              <Link
                href={`/profile/orders/${order.id}`}
                className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-line bg-surface-raised p-4 transition-colors hover:border-indigo-500"
              >
                <span className="min-w-0 space-y-1">
                  <span className="block font-semibold text-fg-strong">
                    Order {order.orderNumber}
                  </span>
                  <span className="block text-sm text-fg-muted">
                    {formatOrderDate(order.createdAt)} · {itemCountLabel(order)}
                  </span>
                  <span className="flex flex-wrap gap-2">
                    <Chip tone={state.tone}>{state.label}</Chip>
                    <Chip tone={payment.tone}>{payment.label}</Chip>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-right">
                  <span className="font-semibold text-fg-strong">
                    {formatAmount(order.totalAmount, order.currency)}
                  </span>
                  <ChevronRight className="h-4 w-4 text-fg-subtle" aria-hidden="true" />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {list.cursor === null ? null : (
        <button
          type="button"
          onClick={list.loadMore}
          disabled={list.phase === 'more'}
          className="min-h-10 w-full rounded-lg border border-line bg-surface-raised px-4 text-sm font-medium hover:bg-hover disabled:opacity-60"
        >
          {list.phase === 'more' ? 'Loading…' : 'Show older orders'}
        </button>
      )}
    </div>
  );
}
