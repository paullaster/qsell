'use client';

import { Suspense, use, useState } from 'react';
import { raiseSalesInvoiceAction, salesInvoicesPageAction } from '@/server/domains/selling/sales-invoice-actions';
import type { SalesInvoiceRow } from '@/server/domains/selling/sales-invoice-service';
import { INVOICE_KIND_WORDS, PAYMENT_WORDS, SIGNING_WORDS } from '@/server/domains/selling/domain/invoice-status';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, LoadFailed, PageHeader, PageSkeleton, buttonClass, cardClass, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { SegmentedChoice } from '@/components/ui/SegmentedChoice';
import { useDebouncedValue } from '@/components/ui/useDebouncedValue';
import { usePagedList } from '@/components/ui/usePagedList';
import type { Choice } from '@/lib/payment-options';
import { PartInvoicePanel } from './PartInvoicePanel';
import { SalesOrderEditor } from '@/components/admin/sales-orders/SalesOrderEditor';
import { SalesInvoiceDetail } from './SalesInvoiceDetail';

type FirstPage = Awaited<ReturnType<typeof salesInvoicesPageAction>>;
type Kind = '' | 'tax_invoice' | 'tax_invoice_part' | 'proforma' | 'delivery_invoice';

const KINDS: readonly { value: Kind; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'tax_invoice', label: 'Tax invoices' },
  { value: 'tax_invoice_part', label: 'Part invoices' },
  { value: 'proforma', label: 'Proforma' },
  { value: 'delivery_invoice', label: 'Delivery' },
];

export function SalesInvoicesClient({ firstPromise }: { firstPromise: Promise<FirstPage> }) {
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <Suspense fallback={<PageSkeleton label="Loading the invoices" />}>
        <Loaded firstPromise={firstPromise} />
      </Suspense>
    </div>
  );
}

function Loaded({ firstPromise }: { firstPromise: Promise<FirstPage> }) {
  const first = use(firstPromise);
  if (!first.ok) return <LoadFailed error={first.error} />;
  return <Body first={first} />;
}

function Body({ first }: { first: Extract<FirstPage, { ok: true }> }) {
  const [typed, setTyped] = useState('');
  const query = useDebouncedValue(typed, 300);
  const [kind, setKind] = useState<Kind>('');
  const [open, setOpen] = useState<string | null>(null);
  const [order, setOrder] = useState<Choice | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  const [raising, setRaising] = useState(false);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const list = usePagedList<SalesInvoiceRow, { query: string; kind: Kind }>({
    filters: { query, kind },
    initialPage: { ok: true, data: { rows: first.data.rows, nextCursor: first.data.nextCursor } },
    load: async (filters, cursor) => {
      const result = await salesInvoicesPageAction({ query: filters.query, kind: filters.kind, cursor });
      return result.ok ? { ok: true, data: { rows: result.data.rows, nextCursor: result.data.nextCursor } } : result;
    },
  });
  const raise = async () => {
    if (order === null) return;
    setRaising(true);
    setNotice(null);
    const r = await raiseSalesInvoiceAction(order.id);
    setRaising(false);
    if (r.ok) {
      setNotice({ kind: 'ok', text: `Invoice ${r.data.invoiceNumber} raised for order ${r.data.orderNumber}.` });
      setOrder(null);
      setPickerKey((n) => n + 1);
      list.reload();
    } else setNotice({ kind: 'error', text: r.error });
  };
  return (
    <>
      <PageHeader
        title="Sales invoices"
        intro="The invoices raised for sales: whether each is signed with KRA, paid or credited. A signed invoice is never edited: it is corrected by a credit note."
        actions={first.data.canCreate && !creating ? <button type="button" className={primaryClass} onClick={() => { setNotice(null); setCreating(true); }}>New sales invoice</button> : null}
      />
      {creating ? (
        <SalesOrderEditor
          variant="sales_invoice"
          onCancel={() => setCreating(false)}
          onPlaced={(text) => {
            setCreating(false);
            setNotice({ kind: 'ok', text });
            list.reload();
          }}
        />
      ) : null}
      {notice === null ? null : <p role={notice.kind === 'error' ? 'alert' : 'status'} className={`rounded-lg border p-3 text-sm ${notice.kind === 'error' ? 'border-red-500/30 bg-red-500/10 text-red-700' : 'border-emerald-500/30 bg-emerald-500/10 text-fg'}`} data-testid="invoice-notice">{notice.text}</p>}
      {first.data.canCreate ? (
        <section className={`${cardClass} space-y-2`} aria-label="Raise an invoice">
          <h2 className="text-sm font-bold text-fg-strong">Raise an invoice</h2>
          <p className="text-xs text-fg-muted">For an order that has none yet, for the whole order. Orders waiting for approval, cancelled or failed are not offered.</p>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <ChoicePicker key={pickerKey} label="Order to invoice" source="invoiceable-orders" choice={order} onChoice={setOrder} placeholder="Search by order number or customer…" />
            <button type="button" className={`${primaryClass} self-end`} disabled={order === null || raising} onClick={() => void raise()}>{raising ? 'Raising…' : 'Raise invoice'}</button>
          </div>
          {order === null ? null : <PartInvoicePanel key={order.id} orderId={order.id} currency={order.meta?.currency ?? 'KES'} onIssued={(text) => { setNotice({ kind: 'ok', text }); list.reload(); }} />}
        </section>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <label htmlFor="sales-invoice-search" className="mb-1 block text-sm font-medium text-fg-muted">Find an invoice</label>
          <input id="sales-invoice-search" type="search" className={fieldClass} placeholder="Invoice number, order number or customer" value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={100} />
        </div>
        <SegmentedChoice label="Kind" value={kind} options={KINDS} onChange={setKind} />
      </div>
      {list.phase === 'error' ? <p role="alert" className="text-sm text-red-700">{list.error} <button type="button" className={buttonClass} onClick={list.retry}>Try again</button></p> : null}
      {list.phase === 'loading' ? <p role="status" className="text-sm text-fg-muted">Loading invoices…</p> : null}
      {list.phase !== 'loading' && list.phase !== 'error' && list.rows.length === 0 ? <p className="rounded-xl border border-line bg-surface-raised p-8 text-center text-sm text-fg-muted" data-testid="invoices-empty">{query === '' && kind === '' ? 'No invoices yet.' : 'No invoices match.'}</p> : null}
      <ul className="space-y-2" aria-label="Invoices" data-testid="sales-invoices">
        {list.rows.map((row) => (
          <li key={row.invoiceNumber} className="space-y-2 rounded-xl border border-line bg-surface-raised p-4" data-testid="sales-invoice">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold break-words text-fg-strong">{row.invoiceNumber}</p>
                <p className="text-sm break-words text-fg-muted">{INVOICE_KIND_WORDS[row.kind] ?? row.kind}{row.salesModule === 'sales_invoice' ? ' (direct sale)' : ''} · order {row.orderNumber} · {row.customerName} · {new Date(row.createdAt).toLocaleDateString()}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-semibold text-fg-strong">{row.currency} {row.total.toLocaleString()}</span>
                <Chip tone={SIGNING_WORDS[row.signing].tone}>{SIGNING_WORDS[row.signing].label}</Chip>
                <Chip tone={PAYMENT_WORDS[row.payment].tone}>{PAYMENT_WORDS[row.payment].label}</Chip>
                {row.credited > 0 && row.payment !== 'credited' ? <Chip tone="sky">{`Credited ${row.currency} ${row.credited.toLocaleString()}`}</Chip> : null}
                <button type="button" className={buttonClass} aria-expanded={open === row.invoiceNumber} aria-label={`${open === row.invoiceNumber ? 'Close' : 'Open'} invoice ${row.invoiceNumber}`} onClick={() => setOpen(open === row.invoiceNumber ? null : row.invoiceNumber)}>{open === row.invoiceNumber ? 'Close' : 'Open'}</button>
              </div>
            </div>
            {open === row.invoiceNumber ? <SalesInvoiceDetail invoiceNumber={row.invoiceNumber} canSend={first.data.canSend} onSent={list.reload} /> : null}
          </li>
        ))}
      </ul>
      {list.cursor === null ? null : <button type="button" className={buttonClass} disabled={list.phase === 'more'} onClick={list.loadMore}>{list.phase === 'more' ? 'Loading…' : 'Show more'}</button>}
    </>
  );
}
