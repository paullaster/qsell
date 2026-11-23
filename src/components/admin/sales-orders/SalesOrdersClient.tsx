'use client';

import { Suspense, use, useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { salesOrdersPageAction } from '@/server/domains/selling/sales-order-actions';
import { creditSalesPageAction } from '@/server/domains/selling/credit-sale-actions';
import type { SalesOrderRow } from '@/server/domains/selling/sales-order-service';
import { Chip, LoadFailed, PageHeader, PageSkeleton, buttonClass, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { useDebouncedValue } from '@/components/ui/useDebouncedValue';
import { usePagedList } from '@/components/ui/usePagedList';
import { SalesOrderEditor } from './SalesOrderEditor';
import { orderHref } from '@/lib/order-links';
import { onOrdersChanged } from '@/lib/orders-changed';
import { useDate } from '@/components/business-time';

type FirstPage = Awaited<ReturnType<typeof salesOrdersPageAction>>;

/** The two lists this screen draws: the orders staff take, and the sales made to a customer's account. */
const VARIANTS = {
  sales_order: { title: 'Sales orders', intro: "Orders staff take for a customer: by phone, at the counter for later, or for an account. The customer's credit and the company's settings are applied when you place one.", create: 'New sales order', empty: 'No sales orders yet.', search: 'Find a sales order', aria: 'Sales orders', load: salesOrdersPageAction },
  credit_sale: { title: 'Credit sales', intro: "Sales to a customer's account, invoiced at once. The customer's credit limit and days, and the company's settings, are applied when you place one.", create: 'New credit sale', empty: 'No credit sales yet.', search: 'Find a credit sale', aria: 'Credit sales', load: creditSalesPageAction },
} as const;
export type ListVariant = keyof typeof VARIANTS;

export function SalesOrdersClient({ firstPromise, variant = 'sales_order' }: { firstPromise: Promise<FirstPage>; variant?: ListVariant }) {
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <Suspense fallback={<PageSkeleton label="Loading the sales orders" />}>
        <Loaded firstPromise={firstPromise} variant={variant} />
      </Suspense>
    </div>
  );
}

function Loaded({ firstPromise, variant }: { firstPromise: Promise<FirstPage>; variant: ListVariant }) {
  const first = use(firstPromise);
  if (!first.ok) return <LoadFailed error={first.error} />;
  return <Body first={first} variant={variant} />;
}

const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'sky' | 'gray'> = { pending: 'amber', processing: 'sky', shipped: 'sky', delivered: 'green', cancelled: 'red' };

function Body({ first, variant }: { first: Extract<FirstPage, { ok: true }>; variant: ListVariant }) {
  const date = useDate();
  const v = VARIANTS[variant];
  const [typed, setTyped] = useState('');
  const query = useDebouncedValue(typed, 300);
  const [creating, setCreating] = useState(false);
  const [placed, setPlaced] = useState<string | null>(null);
  const list = usePagedList<SalesOrderRow, { query: string }>({
    filters: { query },
    initialPage: { ok: true, data: { rows: first.data.rows, nextCursor: first.data.nextCursor } },
    load: async (filters, cursor) => {
      const result = await v.load({ query: filters.query, cursor });
      return result.ok ? { ok: true, data: { rows: result.data.rows, nextCursor: result.data.nextCursor } } : result;
    },
  });
  // An order opened over this list was changed: the rows are read again.
  useEffect(() => onOrdersChanged(list.reload), [list.reload]);
  return (
    <>
      <PageHeader
        title={v.title}
        intro={v.intro}
        actions={first.data.canCreate && !creating ? <button type="button" className={primaryClass} onClick={() => { setPlaced(null); setCreating(true); }}><Plus className="mr-1 inline h-4 w-4" aria-hidden="true" />{v.create}</button> : null}
      />
      {placed === null ? null : <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-fg" data-testid="order-placed">{placed}</p>}
      {creating ? (
        <SalesOrderEditor
          variant={variant}
          onCancel={() => setCreating(false)}
          onPlaced={(text) => {
            setCreating(false);
            setPlaced(text);
            list.reload();
          }}
        />
      ) : null}
      <div>
        <label htmlFor="sales-order-search" className="mb-1 block text-sm font-medium text-fg-muted">{v.search}</label>
        <input id="sales-order-search" type="search" className={fieldClass} placeholder="Order number or customer" value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={100} />
      </div>
      {list.phase === 'error' ? <p role="alert" className="text-sm text-red-700">{list.error} <button type="button" className={buttonClass} onClick={list.retry}>Try again</button></p> : null}
      {list.phase === 'loading' ? <p role="status" className="text-sm text-fg-muted">Loading sales orders…</p> : null}
      {list.phase !== 'loading' && list.phase !== 'error' && list.rows.length === 0 ? <p className="rounded-xl border border-line bg-surface-raised p-8 text-center text-sm text-fg-muted" data-testid="sales-orders-empty">{query === '' ? v.empty : 'None match.'}</p> : null}
      <ul className="space-y-2" aria-label={v.aria} data-testid="sales-orders">
        {list.rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-raised p-4" data-testid="sales-order">
            <div className="min-w-0">
              <p className="font-semibold break-words text-fg-strong">{row.orderNumber}</p>
              <p className="text-sm break-words text-fg-muted">{row.customerName} · {date(row.createdAt)}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold text-fg-strong">{row.currency} {row.total.toLocaleString()}</span>
              <Chip tone={STATUS_TONE[row.status] ?? 'gray'}>{row.status}</Chip>
              <Chip tone={row.paymentStatus === 'paid' ? 'green' : 'gray'}>{row.paymentStatus.replaceAll('_', ' ')}</Chip>
              {row.approvalStatus === 'pending' ? <Chip tone="amber">Waiting for approval</Chip> : null}
              <Link href={orderHref(row.id)} className={buttonClass} aria-label={`Open order ${row.orderNumber}`}>Open order</Link>
            </div>
          </li>
        ))}
      </ul>
      {list.cursor === null ? null : <button type="button" className={buttonClass} disabled={list.phase === 'more'} onClick={list.loadMore}>{list.phase === 'more' ? 'Loading…' : 'Show more'}</button>}
    </>
  );
}
