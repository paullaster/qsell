'use client';

import { use, useState } from 'react';
import { RefreshCw, Search, ShoppingBag } from 'lucide-react';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { usePagedList, type PageResult } from '@/components/ui/usePagedList';
import { useDebouncedValue } from '@/components/ui/useDebouncedValue';
import { buttonClass, fieldClass } from '@/components/ui/screen-kit';
import { ordersPageAction } from '@/server/domains/orders/actions';
import { updateOrderStatusAction, cancelOrderAction } from '@/server/actions';
import { generateInvoicePdfAction, emailInvoiceAction } from '@/server/domains/invoices/actions';
import { downloadPdfBase64 } from '@/lib/downloadPdf';
import { money, unitsIn } from '@/lib/order-admin';
import { shownPaymentReference } from '@/lib/paymentReference';
import type { PublicCompany } from '@/lib/company-view';
import type { Choice } from '@/lib/payment-options';
import type { Order } from '@/types/index';
import { OrderDetailsModal, type FulfilmentChange } from './orders/OrderDetailsModal';
import { OrderInvoicePreview } from './orders/OrderInvoicePreview';
import { OrderStatusBadge } from './orders/OrderStatusBadge';

interface AdminOrdersProps {
  /** The first page, already on its way when the screen is drawn. */
  firstPage: Promise<PageResult<Order>>;
  companyPromise: Promise<PublicCompany>;
}

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

/** The orders, a page at a time: search, narrow by state, and open one to fulfil, invoice, take payment on or credit. */
export function AdminOrders({ firstPage, companyPromise }: AdminOrdersProps) {
  const first = use(firstPage);
  const company = use(companyPromise);

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<Choice | null>(null);
  const query = useDebouncedValue(search.trim());
  const list = usePagedList<Order, { query: string; status: string | null }>({
    load: (filters, cursor) =>
      ordersPageAction({ query: filters.query, status: filters.status, cursor }),
    filters: { query, status: status?.id ?? null },
    initialPage: first,
  });

  // What was changed on screen shows in the list at once, without reading every page again.
  const [patched, setPatched] = useState<Record<string, Order>>({});
  const [selected, setSelected] = useState<Order | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rows = list.rows.map((o) => patched[o.id] ?? o);

  const open = (order: Order) => {
    setSelected(order);
    setError(null);
    setNotice(null);
  };
  const changed = (order: Order) => {
    setPatched((p) => ({ ...p, [order.id]: order }));
    setSelected(order);
  };

  const invoice = async (
    action: 'download' | 'email',
    type: 'tax_invoice' | 'proforma',
    orderId: string,
  ) => {
    setInvoiceBusy(true);
    setNotice(null);
    setError(null);
    try {
      const kind = type === 'proforma' ? 'Proforma invoice' : 'Posted tax invoice';
      if (action === 'download') {
        const result = await generateInvoicePdfAction(orderId, type);
        downloadPdfBase64(result.pdfBase64, result.filename);
        setNotice(`${kind} ${result.invoiceNumber} downloaded.`);
      } else {
        const result = await emailInvoiceAction(orderId, type);
        downloadPdfBase64(result.pdfBase64, result.filename);
        const id = result.emailMessageId ?? '';
        setNotice(
          `${kind} ${result.invoiceNumber} emailed to customer${id === '' ? '' : ` (${id})`}.`,
        );
      }
    } catch (err: unknown) {
      setError(
        messageOf(
          err,
          action === 'download' ? 'Invoice generation failed' : 'Invoice email failed',
        ),
      );
    } finally {
      setInvoiceBusy(false);
    }
  };

  const save = async (order: Order, change: FulfilmentChange) => {
    setBusy(true);
    setError(null);
    try {
      const result = await updateOrderStatusAction(order.id, change);
      if (result.ok) changed(result.data);
      else setError(result.error);
    } catch (err: unknown) {
      setError(messageOf(err, 'The order could not be updated.'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (order: Order, reason: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await cancelOrderAction(order.id, reason);
      if (result.ok) changed(result.data);
      else setError(result.error);
    } catch (err: unknown) {
      setError(messageOf(err, 'The order could not be cancelled.'));
    } finally {
      setBusy(false);
    }
  };

  const reference = (o: Order) => shownPaymentReference(o);

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 rounded-xl border border-line bg-surface-raised p-5 sm:flex-row sm:items-center">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-fg-strong">
            <ShoppingBag className="h-5 w-5 text-indigo-400" aria-hidden />
            Customer Orders &amp; Shipment Processing
          </h2>
          <p className="mt-0.5 text-xs text-fg-muted">
            Review incoming customer orders, assign courier delivery tracking, print packing slips,
            and manage cancellations with automatic stock return.
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
                      {new Date(o.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <OrderStatusBadge status={o.status} />
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
                <button type="button" onClick={() => open(o)} className={`${buttonClass} w-full`}>
                  Manage &amp; Fulfill
                </button>
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
                      {new Date(o.createdAt).toLocaleString([], {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
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
                      <OrderStatusBadge status={o.status} />
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <button type="button" onClick={() => open(o)} className={buttonClass}>
                        Manage &amp; Fulfill
                      </button>
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

      {selected === null ? null : (
        <OrderDetailsModal
          key={selected.id}
          order={selected}
          busy={busy}
          invoiceBusy={invoiceBusy}
          error={error}
          notice={notice}
          onClose={() => setSelected(null)}
          onPreview={() => setPreviewing(true)}
          onInvoice={(action, type) => void invoice(action, type, selected.id)}
          onSave={(change) => void save(selected, change)}
          onCancel={(reason) => void cancel(selected, reason)}
          onChanged={list.reload}
        />
      )}

      {previewing && selected !== null ? (
        <OrderInvoicePreview
          order={selected}
          company={company}
          busy={invoiceBusy}
          onClose={() => setPreviewing(false)}
          onEmail={() => void invoice('email', 'tax_invoice', selected.id)}
          onDownload={(type) => void invoice('download', type, selected.id)}
        />
      ) : null}
    </div>
  );
}
