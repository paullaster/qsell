'use client';

import { use, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BadgeCheck,
  Ban,
  Check,
  Clock3,
  Download,
  FilePlus2,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShoppingCart,
  X,
} from 'lucide-react';
import type { Product } from '@/types/index';
import type { CustomerRow, SalesQuoteRow } from '@/server/db/drizzle/schema';
import type { SalesQuote } from '@/server/domains/quotes/service';
import { downloadPdfBase64 } from '@/lib/downloadPdf';
import {
  approveSalesQuoteAction,
  cancelSalesQuoteAction,
  convertSalesQuoteToOrderAction,
  createSalesQuoteAction,
  generateSalesQuotePdfAction,
  getSalesQuoteAction,
  sendSalesQuoteAction,
  reviseSalesQuoteAction,
  respondToSalesQuoteAction,
  updateSalesQuoteAction,
  updateSalesQuoteSettingsAction,
} from '@/server/domains/quotes/actions';
import type { QuoteInput } from '@/server/domains/quotes/service';

type QuoteLineInput = QuoteInput['lines'][number];

interface EditorData {
  products: Product[];
  customers: CustomerRow[];
  settings: {
    minimumGrossMarginPercent: string;
    nextQuoteNumber: number;
  };
}

const STATUSES = [
  'all',
  'draft',
  'pending_approval',
  'approved',
  'sent',
  'accepted',
  'rejected',
  'converted',
  'expired',
  'cancelled',
] as const;

const money = (value: number, currency: string) =>
  `${currency} ${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function statusLabel(status: string) {
  return status.replaceAll('_', ' ');
}

function newQuoteInput(): QuoteInput {
  return {
    customerName: '',
    customerEmail: '',
    customerPhone: '',
    billingAddress: {},
    deliveryAddress: {},
    currency: 'KES',
    paymentMethod: 'mpesa_daraja',
    validUntil: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
    customerReference: '',
    publicNotes: '',
    internalNotes: '',
    discountPercent: 0,
    shippingFee: 0,
    lines: [],
  };
}

function quoteToInput(quote: SalesQuote): QuoteInput {
  return {
    customerId: quote.customerId,
    customerName: quote.customerName,
    customerEmail: quote.customerEmail,
    customerPhone: quote.customerPhone,
    billingAddress: quote.billingAddress,
    deliveryAddress: quote.deliveryAddress,
    currency: quote.currency,
    paymentMethod: quote.paymentMethod as QuoteInput['paymentMethod'],
    validUntil: quote.validUntil?.toISOString().slice(0, 10) ?? null,
    customerReference: quote.customerReference,
    publicNotes: quote.publicNotes,
    internalNotes: quote.internalNotes,
    discountPercent: Number(quote.quoteDiscountPercent),
    shippingFee: Number(quote.shippingFee),
    lines: quote.lines.map((line) => ({
      productId: line.productId ?? '',
      quantity: Number(line.quantity),
      unitPrice: Number(line.unitPrice),
      discountPercent: Number(line.discountPercent),
    })),
  };
}

export function AdminSalesQuotes({
  quotesPromise,
  editorDataPromise,
  capabilitiesPromise,
}: {
  quotesPromise: Promise<SalesQuoteRow[]>;
  editorDataPromise: Promise<EditorData>;
  capabilitiesPromise: Promise<{
    canCreate: boolean;
    canUpdate: boolean;
    canApprove: boolean;
    canDelete: boolean;
    canConfigure: boolean;
  }>;
}) {
  const quotes = use(quotesPromise);
  const editorData = use(editorDataPromise);
  const capabilities = use(capabilitiesPromise);
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<(typeof STATUSES)[number]>('all');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SalesQuote | null>(null);
  const [details, setDetails] = useState<SalesQuote | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [marginFloor, setMarginFloor] = useState(
    Number(editorData.settings.minimumGrossMarginPercent),
  );

  const filteredQuotes = useMemo(() => {
    const term = search.trim().toLowerCase();
    return quotes.filter((quote) => {
      const isExpired = Boolean(
        quote.validUntil &&
        quote.validUntil < new Date() &&
        !['converted', 'rejected', 'cancelled'].includes(quote.status),
      );
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'expired' ? isExpired : quote.status === statusFilter);
      const matchesTerm =
        !term ||
        [quote.quoteNumber, quote.customerName, quote.customerEmail, quote.customerReference]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(term));
      return matchesStatus && matchesTerm;
    });
  }, [quotes, search, statusFilter]);

  const refresh = () => router.refresh();

  const openCreate = () => {
    setEditing(null);
    setError(null);
    setEditorOpen(true);
  };

  const openEdit = async (id: string) => {
    try {
      setError(null);
      const quote = await getSalesQuoteAction(id);
      if (!quote) throw new Error('Quote not found.');
      setEditing(quote);
      setEditorOpen(true);
      setDetails(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this quote.');
    }
  };

  const withAction = async (id: string, action: () => Promise<unknown>, done: string) => {
    try {
      setBusyId(id);
      setError(null);
      setNotice(null);
      await action();
      setNotice(done);
      setDetails(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The quote action could not be completed.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDownload = async (quote: SalesQuoteRow) => {
    try {
      setBusyId(quote.id);
      const result = await generateSalesQuotePdfAction(quote.id);
      downloadPdfBase64(result.pdfBase64, result.filename);
      setNotice(`${quote.quoteNumber} downloaded.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate this quotation.');
    } finally {
      setBusyId(null);
    }
  };

  const saveMarginFloor = async () => {
    try {
      await updateSalesQuoteSettingsAction(marginFloor);
      setSettingsOpen(false);
      setNotice('Minimum gross margin setting saved.');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save quote settings.');
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-col justify-between gap-4 rounded-xl border border-line bg-surface-raised p-5 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-xl font-bold text-fg-strong">Sales Quotes</h1>
          <p className="mt-1 max-w-3xl text-sm text-fg-muted">
            Create priced quotations, review internal gross margins, obtain approval when below the
            margin floor, send to customers, and convert accepted quotes into orders.
          </p>
          <p className="mt-2 text-xs text-fg-subtle">
            Gross margin = (net selling amount − cost snapshot) ÷ net selling amount. Margin and
            cost are internal only and never appear on customer documents.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {capabilities.canConfigure && (
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm font-medium text-fg hover:bg-hover"
            >
              <Settings2 className="h-4 w-4" /> Margin floor
            </button>
          )}
          <button
            type="button"
            onClick={refresh}
            className="rounded-lg border border-line-strong bg-surface px-3 py-2 text-fg-muted hover:bg-hover"
            aria-label="Refresh quotes"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          {capabilities.canCreate && (
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              <Plus className="h-4 w-4" /> New quote
            </button>
          )}
        </div>
      </header>

      {(error || notice) && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${error ? 'border-red-300 bg-red-50 text-red-800' : 'border-emerald-300 bg-emerald-50 text-emerald-800'}`}
          role={error ? 'alert' : 'status'}
        >
          {error || notice}
        </div>
      )}

      <section className="rounded-xl border border-line bg-surface-raised">
        <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-sm">
            <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search quote number, customer, reference…"
              className="w-full rounded-lg border border-line bg-surface py-2 pr-3 pl-9 text-sm text-fg-strong placeholder:text-fg-subtle"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as (typeof STATUSES)[number])}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong"
            aria-label="Filter quotes by status"
          >
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status === 'all' ? 'All statuses' : statusLabel(status)}
              </option>
            ))}
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[850px] text-left text-sm">
            <thead className="bg-surface text-xs text-fg-muted">
              <tr>
                <th className="px-4 py-3">Quote</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3 text-right">Gross margin</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Valid until</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filteredQuotes.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-fg-muted">
                    {quotes.length === 0
                      ? 'No quotes yet. Create a quote to start the sales workflow.'
                      : 'No quotes match those filters.'}
                  </td>
                </tr>
              ) : (
                filteredQuotes.map((quote) => {
                  const floorMiss =
                    Number(quote.grossMarginPercent) < Number(quote.minimumMarginPercent);
                  const expired =
                    quote.validUntil != null &&
                    quote.validUntil < new Date() &&
                    !['converted', 'rejected', 'cancelled'].includes(quote.status);
                  return (
                    <tr key={quote.id} className="hover:bg-hover/60">
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={async () => setDetails(await getSalesQuoteAction(quote.id))}
                          className="font-semibold text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-300"
                        >
                          {quote.quoteNumber}
                        </button>
                        <div className="mt-0.5 text-xs text-fg-subtle">
                          {new Date(quote.createdAt).toLocaleDateString()}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-fg-strong">{quote.customerName}</div>
                        <div className="text-xs text-fg-muted">
                          {quote.customerEmail || quote.customerReference || '—'}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-semibold text-fg-strong">
                        {money(Number(quote.totalAmount), quote.currency)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span
                          className={`font-mono font-semibold ${floorMiss ? 'text-red-700' : 'text-emerald-700'}`}
                        >
                          {Number(quote.grossMarginPercent).toFixed(1)}%
                        </span>
                        <div className="text-xs text-fg-muted">
                          {money(Number(quote.grossProfit), quote.currency)}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${floorMiss && quote.approvalStatus === 'pending' ? 'bg-amber-100 text-amber-900' : quote.status === 'accepted' || quote.status === 'converted' ? 'bg-emerald-100 text-emerald-800' : quote.status === 'rejected' || quote.status === 'expired' || quote.status === 'cancelled' ? 'bg-red-100 text-red-800' : 'bg-surface-sunken text-fg'}`}
                        >
                          {floorMiss && quote.approvalStatus === 'pending' ? (
                            <Clock3 className="h-3.5 w-3.5" />
                          ) : null}
                          {expired ? 'expired' : statusLabel(quote.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-fg-muted">
                        {quote.validUntil
                          ? new Date(quote.validUntil).toLocaleDateString()
                          : 'No expiry'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <button
                            type="button"
                            title="Download PDF"
                            onClick={() => void handleDownload(quote)}
                            className="rounded-md p-2 text-fg-muted hover:bg-hover hover:text-fg-strong"
                          >
                            <Download className="h-4 w-4" />
                          </button>
                          {(quote.status === 'draft' ||
                            quote.status === 'approved' ||
                            quote.status === 'pending_approval') &&
                            capabilities.canUpdate && (
                              <button
                                type="button"
                                title="Edit quote"
                                onClick={() => void openEdit(quote.id)}
                                className="rounded-md p-2 text-fg-muted hover:bg-hover hover:text-fg-strong"
                              >
                                Edit
                              </button>
                            )}
                          {quote.status === 'pending_approval' && capabilities.canApprove && (
                            <button
                              type="button"
                              title="Approve quote"
                              disabled={busyId === quote.id}
                              onClick={() =>
                                void withAction(
                                  quote.id,
                                  () => approveSalesQuoteAction(quote.id),
                                  `${quote.quoteNumber} approved.`,
                                )
                              }
                              className="rounded-md p-2 text-emerald-700 hover:bg-emerald-50"
                            >
                              <BadgeCheck className="h-4 w-4" />
                            </button>
                          )}
                          {(quote.status === 'draft' || quote.status === 'approved') &&
                            capabilities.canUpdate &&
                            quote.approvalStatus !== 'pending' && (
                              <button
                                type="button"
                                title="Email quotation"
                                disabled={busyId === quote.id}
                                onClick={() =>
                                  void withAction(
                                    quote.id,
                                    () => sendSalesQuoteAction(quote.id),
                                    `${quote.quoteNumber} emailed to ${quote.customerEmail || 'customer'}.`,
                                  )
                                }
                                className="rounded-md p-2 text-indigo-700 hover:bg-indigo-50"
                              >
                                <Send className="h-4 w-4" />
                              </button>
                            )}
                          {quote.status === 'accepted' && capabilities.canApprove && (
                            <button
                              type="button"
                              title="Convert to order"
                              disabled={busyId === quote.id}
                              onClick={() =>
                                void withAction(
                                  quote.id,
                                  async () => {
                                    const order = await convertSalesQuoteToOrderAction(quote.id);
                                    setNotice(`Converted to order ${order?.orderNumber ?? ''}.`);
                                  },
                                  `${quote.quoteNumber} converted to an order.`,
                                )
                              }
                              className="rounded-md p-2 text-emerald-700 hover:bg-emerald-50"
                            >
                              <ShoppingCart className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {editorOpen && (
        <QuoteEditor
          products={editorData.products}
          customers={editorData.customers}
          initial={editing ? quoteToInput(editing) : newQuoteInput()}
          quoteNumber={editing?.quoteNumber}
          minimumMargin={marginFloor}
          onClose={() => setEditorOpen(false)}
          onSave={async (input) => {
            const quote = editing
              ? await updateSalesQuoteAction(editing.id, input)
              : await createSalesQuoteAction(input);
            setEditorOpen(false);
            setNotice(
              `${quote.quoteNumber} saved${quote.approvalStatus === 'pending' ? ' and sent for approval' : ''}.`,
            );
            refresh();
          }}
        />
      )}

      {details && (
        <QuoteDetails
          quote={details}
          canApprove={capabilities.canApprove}
          canDelete={capabilities.canDelete}
          canRevise={capabilities.canCreate}
          busy={busyId === details.id}
          onClose={() => setDetails(null)}
          onApprove={() =>
            void withAction(
              details.id,
              () => approveSalesQuoteAction(details.id),
              `${details.quoteNumber} approved.`,
            )
          }
          onAccept={() =>
            void withAction(
              details.id,
              () => respondToQuote(details.id, true),
              `${details.quoteNumber} marked accepted.`,
            )
          }
          onReject={() =>
            void withAction(
              details.id,
              () => respondToQuote(details.id, false),
              `${details.quoteNumber} marked rejected.`,
            )
          }
          onCancel={() =>
            void withAction(
              details.id,
              () => cancelSalesQuoteAction(details.id),
              `${details.quoteNumber} cancelled.`,
            )
          }
          onRevise={() =>
            void (async () => {
              try {
                const revised = await reviseSalesQuoteAction(details.id);
                setDetails(null);
                await openEdit(revised.id);
                setNotice(`Created revision ${revised.quoteNumber}.`);
                refresh();
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Could not revise this quote.');
              }
            })()
          }
          onConvert={() =>
            void withAction(
              details.id,
              async () => {
                const order = await convertSalesQuoteToOrderAction(details.id);
                setNotice(`Converted to order ${order?.orderNumber ?? ''}.`);
              },
              `${details.quoteNumber} converted to an order.`,
            )
          }
        />
      )}

      {settingsOpen && (
        <Modal title="Quote approval policy" onClose={() => setSettingsOpen(false)}>
          <p className="text-sm text-fg-muted">
            Quotes below this gross margin floor are saved as pending approval. The floor applies to
            new quotes; existing quote margins and approvals remain snapshotted.
          </p>
          <label className="mt-4 block text-sm font-medium text-fg">
            Minimum gross margin %
            <input
              type="number"
              min={0}
              max={100}
              step={0.1}
              value={marginFloor}
              onChange={(event) => setMarginFloor(Number(event.target.value))}
              className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
            />
          </label>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setSettingsOpen(false)}
              className="rounded-lg border border-line px-4 py-2 text-sm text-fg"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void saveMarginFloor()}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white"
            >
              Save policy
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

async function respondToQuote(id: string, accepted: boolean) {
  return respondToSalesQuoteAction(id, accepted);
}

function QuoteEditor({
  products,
  customers,
  initial,
  quoteNumber,
  minimumMargin,
  onClose,
  onSave,
}: {
  products: Product[];
  customers: CustomerRow[];
  initial: QuoteInput;
  quoteNumber?: string;
  minimumMargin: number;
  onClose: () => void;
  onSave: (input: QuoteInput) => Promise<void>;
}) {
  const [input, setInput] = useState<QuoteInput>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linesPreview = input.lines.map((line) => {
    const product = products.find((candidate) => candidate.id === line.productId);
    const unit = line.unitPrice ?? product?.price ?? 0;
    const discount = (1 - line.discountPercent / 100) * (1 - input.discountPercent / 100);
    const gross = unit * line.quantity * discount;
    const rate = product?.taxRate ?? 0;
    const net = product?.isTaxInclusive !== false && rate > 0 ? gross / (1 + rate / 100) : gross;
    const tax = product?.isTaxInclusive !== false && rate > 0 ? gross - net : (net * rate) / 100;
    return {
      line,
      product,
      net,
      tax,
      total: net + tax,
      cost: (product?.costPrice ?? 0) * line.quantity,
      grossProfit: net - (product?.costPrice ?? 0) * line.quantity,
      grossMarginPercent:
        net > 0 ? ((net - (product?.costPrice ?? 0) * line.quantity) / net) * 100 : 0,
    };
  });
  const subtotal = linesPreview.reduce((sum, line) => sum + line.net, 0);
  const tax = linesPreview.reduce((sum, line) => sum + line.tax, 0);
  const total = subtotal + tax + Number(input.shippingFee || 0);
  const cost = linesPreview.reduce((sum, line) => sum + line.cost, 0);
  const grossProfit = subtotal - cost;
  const margin = subtotal > 0 ? (grossProfit / subtotal) * 100 : 0;
  const belowFloor = margin < minimumMargin;

  const setField = <K extends keyof QuoteInput>(key: K, value: QuoteInput[K]) =>
    setInput((current) => ({ ...current, [key]: value }));
  const addProduct = (productId: string) => {
    if (!productId) return;
    if (input.lines.some((line) => line.productId === productId)) return;
    const product = products.find((item) => item.id === productId);
    if (!product) return;
    setField('lines', [
      ...input.lines,
      { productId, quantity: 1, unitPrice: product.price, discountPercent: 0 },
    ]);
  };
  const patchLine = (index: number, patch: Partial<QuoteLineInput>) =>
    setField(
      'lines',
      input.lines.map((line, lineIndex) => (lineIndex === index ? { ...line, ...patch } : line)),
    );

  const chooseCustomer = (id: string) => {
    const customer = customers.find((item) => item.id === id);
    if (!customer) {
      setInput((current) => ({ ...current, customerId: null }));
      return;
    }
    const address = {
      street: customer.street ?? '',
      city: customer.city ?? '',
      countyOrState: customer.countyOrState ?? '',
      postalCode: customer.postalCode ?? '',
      country: customer.country ?? 'Kenya',
    };
    setInput((current) => ({
      ...current,
      customerId: customer.id,
      customerName: customer.name,
      customerEmail: customer.email ?? '',
      customerPhone: customer.phone ?? '',
      billingAddress: address,
      deliveryAddress: address,
      paymentMethod: customer.accountType === 'credit' ? 'on_account' : current.paymentMethod,
    }));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      setBusy(true);
      setError(null);
      await onSave(input);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this quote.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={quoteNumber ? `Edit ${quoteNumber}` : 'Create sales quote'}
      onClose={onClose}
      wide
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-5">
        {error && (
          <p
            className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
            role="alert"
          >
            {error}
          </p>
        )}
        <section className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-medium text-fg">
            Trade customer
            <select
              value={input.customerId ?? ''}
              onChange={(event) => chooseCustomer(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
            >
              <option value="">New / one-time customer</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.number} · {customer.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium text-fg">
            Customer name
            <input
              required
              value={input.customerName}
              onChange={(event) => setField('customerName', event.target.value)}
              className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
            />
          </label>
          <label className="text-sm font-medium text-fg">
            Email
            <input
              type="email"
              value={input.customerEmail ?? ''}
              onChange={(event) => setField('customerEmail', event.target.value)}
              className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
            />
          </label>
          <label className="text-sm font-medium text-fg">
            Phone
            <input
              value={input.customerPhone ?? ''}
              onChange={(event) => setField('customerPhone', event.target.value)}
              className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
            />
          </label>
          <label className="text-sm font-medium text-fg">
            Customer reference / PO
            <input
              value={input.customerReference ?? ''}
              onChange={(event) => setField('customerReference', event.target.value)}
              className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
            />
          </label>
          <label className="text-sm font-medium text-fg">
            Valid until
            <input
              type="date"
              value={input.validUntil ?? ''}
              onChange={(event) => setField('validUntil', event.target.value || null)}
              className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
            />
          </label>
          <label className="text-sm font-medium text-fg">
            Currency
            <select
              value={input.currency}
              onChange={(event) => setField('currency', event.target.value)}
              className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
            >
              <option>KES</option>
              <option>USD</option>
            </select>
          </label>
          <label className="text-sm font-medium text-fg">
            Payment method
            <select
              value={input.paymentMethod}
              onChange={(event) =>
                setField('paymentMethod', event.target.value as QuoteInput['paymentMethod'])
              }
              className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
            >
              <option value="mpesa_daraja">M-Pesa</option>
              <option value="pesapal_v3">Pesapal</option>
              <option value="jenga_hq">Jenga</option>
              <option value="kcb_buni">KCB Buni</option>
              {input.customerId &&
                customers.find((customer) => customer.id === input.customerId)?.accountType ===
                  'credit' && <option value="on_account">On account</option>}
            </select>
          </label>
        </section>

        <section className="rounded-xl border border-line">
          <div className="flex flex-col justify-between gap-2 border-b border-line p-3 sm:flex-row sm:items-center">
            <div>
              <h3 className="font-semibold text-fg-strong">Quote lines</h3>
              <p className="text-xs text-fg-muted">
                Unit cost is snapshotted for internal margin review only.
              </p>
            </div>
            <select
              defaultValue=""
              onChange={(event) => {
                addProduct(event.target.value);
                event.target.value = '';
              }}
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong"
            >
              <option value="">Add product…</option>
              {products
                .filter(
                  (product) =>
                    product.isSellable &&
                    !input.lines.some((line) => line.productId === product.id),
                )
                .map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.sku} · {product.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="bg-surface text-xs text-fg-muted">
                <tr>
                  <th className="p-3">Item</th>
                  <th className="p-3">Qty</th>
                  <th className="p-3">Unit price</th>
                  <th className="p-3">Disc %</th>
                  <th className="p-3 text-right">Cost</th>
                  <th className="p-3 text-right">Gross profit</th>
                  <th className="p-3 text-right">Gross margin</th>
                  <th className="p-3 text-right">Line total</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {linesPreview.map(
                  (
                    {
                      line,
                      product,
                      total: lineTotal,
                      cost: lineCost,
                      grossProfit: lineProfit,
                      grossMarginPercent: lineMargin,
                    },
                    index,
                  ) => (
                    <tr key={line.productId}>
                      <td className="p-3">
                        <div className="font-medium text-fg-strong">{product?.name}</div>
                        <div className="text-xs text-fg-muted">
                          {product?.sku} · tax {product?.taxRate ?? 0}%
                        </div>
                      </td>
                      <td className="p-3">
                        <input
                          aria-label="Quantity"
                          type="number"
                          min="0.001"
                          step="0.001"
                          value={line.quantity}
                          onChange={(event) =>
                            patchLine(index, { quantity: Number(event.target.value) })
                          }
                          className="w-24 rounded-md border border-line bg-surface px-2 py-1 text-fg-strong"
                        />
                      </td>
                      <td className="p-3">
                        <input
                          aria-label="Unit selling price"
                          type="number"
                          min="0"
                          step="0.01"
                          value={line.unitPrice ?? ''}
                          onChange={(event) =>
                            patchLine(index, { unitPrice: Number(event.target.value) })
                          }
                          className="w-28 rounded-md border border-line bg-surface px-2 py-1 text-fg-strong"
                        />
                      </td>
                      <td className="p-3">
                        <input
                          aria-label="Line discount percent"
                          type="number"
                          min="0"
                          max="100"
                          step="0.1"
                          value={line.discountPercent}
                          onChange={(event) =>
                            patchLine(index, { discountPercent: Number(event.target.value) })
                          }
                          className="w-20 rounded-md border border-line bg-surface px-2 py-1 text-fg-strong"
                        />
                      </td>
                      <td className="p-3 text-right text-xs text-fg-muted">
                        {money(lineCost, input.currency)}
                      </td>
                      <td
                        className={`p-3 text-right text-xs font-semibold ${lineProfit < 0 ? 'text-red-700' : 'text-fg-strong'}`}
                      >
                        {money(lineProfit, input.currency)}
                      </td>
                      <td
                        className={`p-3 text-right text-xs font-semibold ${lineMargin < minimumMargin ? 'text-amber-800' : 'text-emerald-700'}`}
                      >
                        {lineMargin.toFixed(1)}%
                      </td>
                      <td className="p-3 text-right font-mono font-semibold text-fg-strong">
                        {money(lineTotal, input.currency)}
                      </td>
                      <td className="p-3">
                        <button
                          type="button"
                          onClick={() =>
                            setField(
                              'lines',
                              input.lines.filter((_, i) => i !== index),
                            )
                          }
                          className="rounded p-1 text-fg-muted hover:bg-red-50 hover:text-red-700"
                          aria-label="Remove line"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ),
                )}
                {input.lines.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-sm text-fg-muted">
                      Choose an item above to start your quote.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium text-fg">
              Quote discount %
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={input.discountPercent}
                onChange={(event) => setField('discountPercent', Number(event.target.value))}
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
            <label className="text-sm font-medium text-fg">
              Shipping
              <input
                type="number"
                min="0"
                step="0.01"
                value={input.shippingFee}
                onChange={(event) => setField('shippingFee', Number(event.target.value))}
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
            <label className="text-sm font-medium text-fg sm:col-span-2">
              Billing address
              <div className="mt-1 grid grid-cols-2 gap-2">
                {(['street', 'city', 'countyOrState', 'postalCode', 'country'] as const).map(
                  (field) => (
                    <input
                      key={field}
                      placeholder={
                        field === 'countyOrState'
                          ? 'County / State'
                          : field[0]!.toUpperCase() + field.slice(1)
                      }
                      value={input.billingAddress?.[field] ?? ''}
                      onChange={(event) =>
                        setField('billingAddress', {
                          ...input.billingAddress,
                          [field]: event.target.value,
                        })
                      }
                      className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong"
                    />
                  ),
                )}
              </div>
            </label>
            <label className="text-sm font-medium text-fg sm:col-span-2">
              Delivery address
              <div className="mt-1 grid grid-cols-2 gap-2">
                {(['street', 'city', 'countyOrState', 'postalCode', 'country'] as const).map(
                  (field) => (
                    <input
                      key={field}
                      required={field !== 'postalCode'}
                      placeholder={
                        field === 'countyOrState'
                          ? 'County / State'
                          : field[0]!.toUpperCase() + field.slice(1)
                      }
                      value={input.deliveryAddress?.[field] ?? ''}
                      onChange={(event) =>
                        setField('deliveryAddress', {
                          ...input.deliveryAddress,
                          [field]: event.target.value,
                        })
                      }
                      className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong"
                    />
                  ),
                )}
              </div>
            </label>
            <label className="text-sm font-medium text-fg">
              Customer-facing notes
              <textarea
                rows={2}
                value={input.publicNotes ?? ''}
                onChange={(event) => setField('publicNotes', event.target.value)}
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
            <label className="text-sm font-medium text-fg">
              Internal notes
              <textarea
                rows={2}
                value={input.internalNotes ?? ''}
                onChange={(event) => setField('internalNotes', event.target.value)}
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
          </div>
          <aside className="rounded-xl border border-line bg-surface p-4">
            <h3 className="font-semibold text-fg-strong">Internal margin review</h3>
            <p className="mt-1 text-xs text-fg-muted">
              These figures are never included in the customer PDF or email.
            </p>
            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-fg-muted">Net subtotal</dt>
                <dd className="font-mono text-fg-strong">{money(subtotal, input.currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-fg-muted">Tax</dt>
                <dd className="font-mono text-fg-strong">{money(tax, input.currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-fg-muted">Shipping</dt>
                <dd className="font-mono text-fg-strong">
                  {money(Number(input.shippingFee), input.currency)}
                </dd>
              </div>
              <div className="flex justify-between border-t border-line pt-2 font-semibold">
                <dt className="text-fg">Quote total</dt>
                <dd className="font-mono text-fg-strong">{money(total, input.currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-fg-muted">Cost snapshot</dt>
                <dd className="font-mono text-fg-strong">{money(cost, input.currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-fg-muted">Gross profit</dt>
                <dd className="font-mono text-fg-strong">{money(grossProfit, input.currency)}</dd>
              </div>
              <div
                className={`flex justify-between rounded-lg px-2 py-1.5 font-bold ${belowFloor ? 'bg-amber-100 text-amber-950' : 'bg-emerald-50 text-emerald-800'}`}
              >
                <dt>Gross margin</dt>
                <dd>{margin.toFixed(1)}%</dd>
              </div>
            </dl>
            {belowFloor && (
              <p className="mt-3 text-xs font-medium text-amber-900">
                Below the {minimumMargin.toFixed(1)}% approval floor. Saving sends this quote to the
                approval queue.
              </p>
            )}
          </aside>
        </section>

        <footer className="flex justify-end gap-2 border-t border-line pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-4 py-2 text-sm text-fg"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || input.lines.length === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? (
              'Saving…'
            ) : (
              <>
                <FilePlus2 className="h-4 w-4" /> Save quote
              </>
            )}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function QuoteDetails({
  quote,
  canApprove,
  canDelete,
  canRevise,
  busy,
  onClose,
  onApprove,
  onAccept,
  onReject,
  onCancel,
  onRevise,
  onConvert,
}: {
  quote: SalesQuote;
  canApprove: boolean;
  canDelete: boolean;
  canRevise: boolean;
  busy: boolean;
  onClose: () => void;
  onApprove: () => void;
  onAccept: () => void;
  onReject: () => void;
  onCancel: () => void;
  onRevise: () => void;
  onConvert: () => void;
}) {
  const floorMiss = Number(quote.grossMarginPercent) < Number(quote.minimumMarginPercent);
  return (
    <Modal title={`${quote.quoteNumber} · ${statusLabel(quote.status)}`} onClose={onClose} wide>
      <div className="space-y-5">
        <section className="grid gap-3 sm:grid-cols-3">
          <Summary
            label="Customer"
            value={quote.customerName}
            detail={quote.customerEmail ?? undefined}
          />
          <Summary
            label="Quote total"
            value={money(Number(quote.totalAmount), quote.currency)}
            detail={`Valid until ${quote.validUntil ? new Date(quote.validUntil).toLocaleDateString() : 'no expiry'}`}
          />
          <Summary
            label="Internal gross margin"
            value={`${Number(quote.grossMarginPercent).toFixed(1)}%`}
            detail={`${money(Number(quote.grossProfit), quote.currency)} gross profit · floor ${Number(quote.minimumMarginPercent).toFixed(1)}%`}
            danger={floorMiss}
          />
        </section>
        <section className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[600px] text-left text-sm">
            <thead className="bg-surface text-xs text-fg-muted">
              <tr>
                <th className="p-3">Item</th>
                <th className="p-3 text-right">Qty</th>
                <th className="p-3 text-right">Price</th>
                <th className="p-3 text-right">Cost (internal)</th>
                <th className="p-3 text-right">Margin (internal)</th>
                <th className="p-3 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {quote.lines.map((line) => {
                const revenue = Number(line.netAmount);
                const profit = revenue - Number(line.costAmount);
                const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
                return (
                  <tr key={line.id}>
                    <td className="p-3">
                      <div className="font-medium text-fg-strong">{line.description}</div>
                      <div className="text-xs text-fg-muted">
                        {line.sku} · tax {Number(line.taxRate)}%
                      </div>
                    </td>
                    <td className="p-3 text-right">{Number(line.quantity)}</td>
                    <td className="p-3 text-right">
                      {money(Number(line.unitPrice), quote.currency)}
                    </td>
                    <td className="p-3 text-right text-fg-muted">
                      {money(Number(line.costAmount), quote.currency)}
                    </td>
                    <td
                      className={`p-3 text-right font-semibold ${margin < Number(quote.minimumMarginPercent) ? 'text-red-700' : 'text-emerald-700'}`}
                    >
                      {margin.toFixed(1)}%
                    </td>
                    <td className="p-3 text-right font-semibold text-fg-strong">
                      {money(Number(line.lineAmount), quote.currency)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
        {quote.internalNotes && (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
            <strong>Internal:</strong> {quote.internalNotes}
          </p>
        )}
        <section className="rounded-xl border border-line p-4">
          <h3 className="mb-3 font-semibold text-fg-strong">Document history</h3>
          <ol className="space-y-2">
            {quote.events.map((event) => (
              <li key={event.id} className="flex justify-between gap-3 text-sm">
                <span className="text-fg-strong capitalize">
                  {event.eventType.replaceAll('_', ' ')}
                </span>
                <time className="text-xs text-fg-muted">
                  {new Date(event.createdAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ol>
        </section>
        <footer className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
          {quote.status === 'pending_approval' && canApprove && (
            <ActionButton
              onClick={onApprove}
              disabled={busy}
              icon={<BadgeCheck className="h-4 w-4" />}
            >
              Approve
            </ActionButton>
          )}
          {quote.status === 'sent' && canApprove && (
            <>
              <ActionButton onClick={onAccept} disabled={busy} icon={<Check className="h-4 w-4" />}>
                Mark accepted
              </ActionButton>
              <ActionButton onClick={onReject} disabled={busy} icon={<Ban className="h-4 w-4" />}>
                Mark rejected
              </ActionButton>
            </>
          )}
          {quote.status === 'accepted' && canApprove && (
            <ActionButton
              onClick={onConvert}
              disabled={busy}
              icon={<ShoppingCart className="h-4 w-4" />}
            >
              Convert to order
            </ActionButton>
          )}
          {canRevise && !['converted', 'cancelled'].includes(quote.status) && (
            <ActionButton
              onClick={onRevise}
              disabled={busy}
              icon={<FilePlus2 className="h-4 w-4" />}
            >
              Create revision
            </ActionButton>
          )}
          {canDelete &&
            !['converted', 'cancelled', 'rejected', 'expired'].includes(quote.status) && (
              <ActionButton onClick={onCancel} disabled={busy} icon={<Ban className="h-4 w-4" />}>
                Cancel quote
              </ActionButton>
            )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-4 py-2 text-sm text-fg"
          >
            Close
          </button>
        </footer>
      </div>
    </Modal>
  );
}

function Summary({
  label,
  value,
  detail,
  danger,
}: {
  label: string;
  value: string;
  detail?: string;
  danger?: boolean;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="text-xs text-fg-muted">{label}</div>
      <div className={`mt-1 font-semibold ${danger ? 'text-red-700' : 'text-fg-strong'}`}>
        {value}
      </div>
      {detail && <div className="mt-1 text-xs text-fg-subtle">{detail}</div>}
    </div>
  );
}

function ActionButton({
  children,
  icon,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm font-medium text-fg hover:bg-hover disabled:opacity-50"
    >
      {icon}
      {children}
    </button>
  );
}

function Modal({
  children,
  title,
  onClose,
  wide = false,
}: {
  children: React.ReactNode;
  title: string;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-backdrop/70 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`max-h-[94dvh] w-full overflow-y-auto rounded-2xl border border-line bg-surface-raised p-4 shadow-2xl sm:p-6 ${wide ? 'max-w-6xl' : 'max-w-3xl'}`}
      >
        <header className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-fg-strong">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-lg p-2 text-fg-muted hover:bg-hover"
          >
            <X className="h-5 w-5" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
