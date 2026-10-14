'use client';

import { use, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BadgeCheck,
  Ban,
  Check,
  Clock3,
  Download,
  Eye,
  FilePlus2,
  Plus,
  RefreshCw,
  Search,
  Send,
  MailWarning,
  Settings2,
  ShoppingCart,
  Files,
  X,
} from 'lucide-react';
import type { CatalogueProduct } from '@/lib/catalogue-entry';
import type { CustomerRow, SalesQuoteRow } from '@/server/db/drizzle/schema';
import type {
  QuoteTemplateInput,
  SalesQuote,
  SalesQuoteTemplate,
} from '@/server/domains/quotes/service';
import { downloadPdfBase64 } from '@/lib/downloadPdf';
import {
  approveSalesQuoteAction,
  resubmitSalesQuoteApprovalAction,
  cancelSalesQuoteAction,
  convertSalesQuoteToOrderAction,
  createSalesQuoteAction,
  generateSalesQuotePdfAction,
  getSalesQuoteAction,
  sendSalesQuoteAction,
  reviseSalesQuoteAction,
  saveSalesQuoteTemplateAction,
  duplicateSalesQuoteTemplateAction,
  archiveSalesQuoteTemplateAction,
  setDefaultSalesQuoteTemplateAction,
  respondToSalesQuoteAction,
  updateSalesQuoteAction,
  updateSalesQuoteSettingsAction,
} from '@/server/domains/quotes/actions';
import type { QuoteInput } from '@/server/domains/quotes/service';
import { AdminSalesQuoteTemplates } from './AdminSalesQuoteTemplates';
import { QuoteLinePriceNote } from './pricing/QuoteLinePriceNote';
import { useQuotePricePreview } from './pricing/useQuotePricePreview';
import { useQuoteGuardPreview } from './pricing/useQuoteGuardPreview';
import { QuoteCoupons } from './pricing/QuoteCoupons';
import { kitCost, kitTax } from '@/server/domains/pricing/domain/kits';
import { QuoteLayoutBoard } from './quote-layout/QuoteLayoutBoard';
import { CataloguePicker } from './quote-layout/CataloguePicker';
import { QuickAdd } from './quote-layout/QuickAdd';
import { BulkAddDialog } from './quote-layout/BulkAddDialog';
import { QuantityInput } from './quote-layout/QuantityInput';
import { TemplateSwapDialog } from './quote-layout/TemplateSwapDialog';
import { planTemplateSwap, templateContent, type SwapPlan } from '@/lib/quote-template-swap';
import { buildCatalogueIndex } from '@/lib/catalogue-entry';
import { addCatalogueEntry, lastIndexOfProduct, type CatalogueEntry } from '@/lib/quote-layout';
import type { QuoteSearchHit } from '@/server/domains/quotes/service';
import type { EditorKit } from '@/server/domains/quotes/actions';
import { unwrapQuoteAction } from '@/server/domains/quotes/action-result';

type QuoteLineInput = QuoteInput['lines'][number];

interface EditorData {
  products: CatalogueProduct[];
  kits: EditorKit[];
  customers: CustomerRow[];
  settings: {
    minimumGrossMarginPercent: string;
    nextQuoteNumber: number;
  };
  templates: SalesQuoteTemplate[];
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
    paymentTerms: '',
    templateId: null,
    showBillingAddress: false,
    paymentDetails: '',
    termsAndConditions: '',
    sections: [],
    validUntil: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
    customerReference: '',
    publicNotes: '',
    internalNotes: '',
    discountPercent: 0,
    shippingFee: 0,
    couponCodes: [],
    lines: [],
  };
}

function quoteToInput(quote: SalesQuote): QuoteInput {
  const sectionIdMap = new Map(quote.sections.map((section) => [section.id, crypto.randomUUID()]));
  return {
    customerId: quote.customerId,
    customerName: quote.customerName,
    customerEmail: quote.customerEmail,
    customerPhone: quote.customerPhone,
    billingAddress: quote.billingAddress,
    deliveryAddress: quote.deliveryAddress,
    currency: quote.currency,
    paymentMethod: quote.paymentMethod as QuoteInput['paymentMethod'],
    paymentTerms: quote.paymentTerms,
    templateId: quote.templateId,
    showBillingAddress: quote.showBillingAddress,
    paymentDetails: quote.paymentDetails,
    termsAndConditions: quote.termsAndConditions,
    sections: quote.sections.map((section) => ({
      id: sectionIdMap.get(section.id)!,
      title: section.title,
      description: section.description,
      showLines: section.showLines,
      fromTemplate: section.fromTemplate,
    })),
    validUntil: quote.validUntil?.toISOString().slice(0, 10) ?? null,
    customerReference: quote.customerReference,
    publicNotes: quote.publicNotes,
    internalNotes: quote.internalNotes,
    discountPercent: Number(quote.quoteDiscountPercent),
    shippingFee: Number(quote.shippingFee),
    couponCodes: quote.couponCodes ?? [],
    // Free gifts are worked out again on every save, so they are not editable lines.
    lines: quote.lines
      .filter((line) => !line.isGift)
      .map((line) => ({
        productId: line.productId ?? '',
        sectionId: line.sectionId ? (sectionIdMap.get(line.sectionId) ?? null) : null,
        quantity: Number(line.quantity),
        unitPrice: Number(line.unitPrice),
        // The price already agreed stays as it is until someone asks to reprice it.
        priceMode: 'kept' as const,
        discountPercent: Number(line.discountPercent),
        fromTemplate: line.fromTemplate,
      })),
  };
}

function quoteInputFromTemplate(
  template: SalesQuoteTemplate,
  products: CatalogueProduct[],
  customers: CustomerRow[],
): QuoteInput {
  const customer = customers.find((row) => row.id === template.customerId);
  const address: Record<string, string> = customer
    ? {
        street: customer.street ?? '',
        city: customer.city ?? '',
        countyOrState: customer.countyOrState ?? '',
        postalCode: customer.postalCode ?? '',
        country: customer.country ?? 'Kenya',
      }
    : {};
  const content = templateContent(template, (id) => products.find((row) => row.id === id)?.price);
  return {
    ...newQuoteInput(),
    customerId: customer?.id ?? null,
    customerName: customer?.name ?? '',
    customerEmail: customer?.email ?? '',
    customerPhone: customer?.phone ?? '',
    billingAddress: template.billingAddress.street ? template.billingAddress : address,
    deliveryAddress: template.deliveryAddress.street ? template.deliveryAddress : address,
    currency: template.currency,
    paymentMethod: template.paymentMethod as QuoteInput['paymentMethod'],
    paymentTerms: template.paymentTerms,
    paymentDetails: template.paymentDetails,
    termsAndConditions: template.termsAndConditions,
    showBillingAddress: template.showBillingAddress,
    templateId: template.id,
    validUntil: new Date(Date.now() + template.validityDays * 86400000).toISOString().slice(0, 10),
    publicNotes: template.publicNotes,
    internalNotes: template.internalNotes,
    discountPercent: Number(template.quoteDiscountPercent),
    shippingFee: Number(template.shippingFee),
    ...content,
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
  const [activeTab, setActiveTab] = useState<'quotes' | 'templates'>('quotes');
  const [statusFilter, setStatusFilter] = useState<(typeof STATUSES)[number]>('all');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SalesQuote | null>(null);
  const [details, setDetails] = useState<SalesQuote | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewPdf, setPreviewPdf] = useState<string | null>(null);
  /** A quote someone chose to make a template from: the Templates tab opens its editor on it. */
  const [templateFrom, setTemplateFrom] = useState<QuoteSearchHit | null>(null);
  const startTemplate = (quote: SalesQuoteRow) => {
    setTemplateFrom({
      id: quote.id,
      quoteNumber: quote.quoteNumber,
      customerName: quote.customerName,
      customerEmail: quote.customerEmail,
      status: quote.status,
      currency: quote.currency,
      totalAmount: Number(quote.totalAmount),
      validUntil: quote.validUntil ? new Date(quote.validUntil).toISOString() : null,
      expired:
        quote.validUntil != null &&
        new Date(quote.validUntil) < new Date() &&
        !['converted', 'rejected', 'cancelled'].includes(quote.status),
    });
    setDetails(null);
    setActiveTab('templates');
  };
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
      const result = unwrapQuoteAction(await generateSalesQuotePdfAction(quote.id));
      downloadPdfBase64(result.pdfBase64, result.filename);
      setNotice(`${quote.quoteNumber} downloaded.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate this quotation.');
    } finally {
      setBusyId(null);
    }
  };

  const handlePreview = async (id: string) => {
    try {
      setBusyId(id);
      const result = unwrapQuoteAction(await generateSalesQuotePdfAction(id));
      setPreviewPdf(result.pdfBase64);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not preview this quotation.');
    } finally {
      setBusyId(null);
    }
  };

  const saveMarginFloor = async () => {
    try {
      unwrapQuoteAction(await updateSalesQuoteSettingsAction(marginFloor));
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
          {capabilities.canCreate && activeTab === 'quotes' && (
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

      <div
        className="flex gap-1 border-b border-line"
        role="tablist"
        aria-label="Sales quotes workspace"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'quotes'}
          onClick={() => setActiveTab('quotes')}
          className={`border-b-2 px-4 py-2.5 text-sm font-semibold ${activeTab === 'quotes' ? 'border-indigo-600 text-indigo-700 dark:text-indigo-300' : 'border-transparent text-fg-muted hover:text-fg-strong'}`}
        >
          Quotes
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'templates'}
          onClick={() => setActiveTab('templates')}
          className={`inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold ${activeTab === 'templates' ? 'border-indigo-600 text-indigo-700 dark:text-indigo-300' : 'border-transparent text-fg-muted hover:text-fg-strong'}`}
        >
          <Files className="h-4 w-4" /> Templates
        </button>
      </div>

      {activeTab === 'quotes' ? (
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
                            className="inline-flex items-center gap-1 font-semibold text-indigo-700 underline decoration-indigo-400 decoration-1 underline-offset-4 hover:text-indigo-900 hover:decoration-2 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:text-indigo-300 dark:decoration-indigo-300 dark:hover:text-indigo-100"
                          >
                            {quote.quoteNumber}
                            <span className="text-xs font-medium">View details</span>
                          </button>
                          <div className="mt-0.5 text-xs text-fg-subtle">
                            {new Date(quote.createdAt).toLocaleDateString()}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-fg-strong">{quote.customerName}</div>
                          {quote.customerEmail ? (
                            <div className="text-xs text-fg-muted">{quote.customerEmail}</div>
                          ) : (
                            <div className="text-xs text-fg-muted">
                              {quote.customerReference || '—'}
                            </div>
                          )}
                          {!quote.customerEmail && ['draft', 'approved'].includes(quote.status) && (
                            <span className="mt-1 inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs font-semibold text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                              <MailWarning className="h-3 w-3" aria-hidden="true" />
                              No email: edit the quote to add one
                            </span>
                          )}
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
                          <ApprovalNote quote={quote} />
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
                              title={`View ${quote.quoteNumber}`}
                              aria-label={`View ${quote.quoteNumber}`}
                              onClick={async () => setDetails(await getSalesQuoteAction(quote.id))}
                              className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-xs font-semibold text-indigo-800 hover:bg-indigo-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200 dark:hover:bg-indigo-900/60"
                            >
                              <Eye className="h-3.5 w-3.5" /> View
                            </button>
                            {capabilities.canCreate && (
                              <button
                                type="button"
                                title="Create a template from this quote"
                                aria-label={`Create a template from ${quote.quoteNumber}`}
                                onClick={() => startTemplate(quote)}
                                className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-indigo-600"
                              >
                                <Files className="h-4 w-4" />
                              </button>
                            )}
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
                            {quote.status === 'pending_approval' &&
                              capabilities.canApprove &&
                              quote.approvalManagedBy !== 'workflow' && (
                                <button
                                  type="button"
                                  title="Approve quote"
                                  disabled={busyId === quote.id}
                                  onClick={() =>
                                    void withAction(
                                      quote.id,
                                      () =>
                                        approveSalesQuoteAction(quote.id).then(unwrapQuoteAction),
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
                              !['pending', 'rejected', 'draft'].includes(quote.approvalStatus) && (
                                <button
                                  type="button"
                                  title={
                                    quote.customerEmail
                                      ? 'Email quotation'
                                      : 'Add a customer email to this quote before sending it'
                                  }
                                  aria-label={
                                    quote.customerEmail
                                      ? `Email ${quote.quoteNumber}`
                                      : `Cannot email ${quote.quoteNumber}: no customer email`
                                  }
                                  disabled={busyId === quote.id || !quote.customerEmail}
                                  onClick={() =>
                                    void withAction(
                                      quote.id,
                                      () => sendSalesQuoteAction(quote.id).then(unwrapQuoteAction),
                                      `${quote.quoteNumber} emailed to ${quote.customerEmail || 'customer'}.`,
                                    )
                                  }
                                  className="rounded-md p-2 text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
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
                                      const order = unwrapQuoteAction(
                                        await convertSalesQuoteToOrderAction(quote.id),
                                      );
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
      ) : (
        <AdminSalesQuoteTemplates
          templates={editorData.templates}
          products={editorData.products}
          customers={editorData.customers}
          canCreate={capabilities.canCreate}
          canUpdate={capabilities.canUpdate}
          canDelete={capabilities.canDelete}
          onRefresh={refresh}
          onMessage={setNotice}
          onError={setError}
          fromQuote={templateFrom}
          onFromQuoteHandled={() => setTemplateFrom(null)}
        />
      )}

      {editorOpen && (
        <QuoteEditor
          products={editorData.products}
          kits={editorData.kits}
          customers={editorData.customers}
          templates={editorData.templates}
          initial={editing ? quoteToInput(editing) : newQuoteInput()}
          quoteNumber={editing?.quoteNumber}
          minimumMargin={marginFloor}
          onClose={() => setEditorOpen(false)}
          onSave={async (input) => {
            const quote = editing
              ? unwrapQuoteAction(await updateSalesQuoteAction(editing.id, input))
              : unwrapQuoteAction(await createSalesQuoteAction(input));
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
          onTemplate={() => startTemplate(details)}
          busy={busyId === details.id}
          onClose={() => setDetails(null)}
          onApprove={() =>
            void withAction(
              details.id,
              () => approveSalesQuoteAction(details.id).then(unwrapQuoteAction),
              `${details.quoteNumber} approved.`,
            )
          }
          onResubmit={() =>
            void withAction(
              details.id,
              () => resubmitSalesQuoteApprovalAction(details.id).then(unwrapQuoteAction),
              `${details.quoteNumber} sent for approval again.`,
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
              () => cancelSalesQuoteAction(details.id).then(unwrapQuoteAction),
              `${details.quoteNumber} cancelled.`,
            )
          }
          onRevise={() =>
            void (async () => {
              try {
                const revised = unwrapQuoteAction(await reviseSalesQuoteAction(details.id));
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
                const order = unwrapQuoteAction(await convertSalesQuoteToOrderAction(details.id));
                setNotice(`Converted to order ${order?.orderNumber ?? ''}.`);
              },
              `${details.quoteNumber} converted to an order.`,
            )
          }
          onPreview={() => void handlePreview(details.id)}
        />
      )}

      {previewPdf && <PdfPreview base64={previewPdf} onClose={() => setPreviewPdf(null)} />}

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
  return respondToSalesQuoteAction(id, accepted).then(unwrapQuoteAction);
}

function QuoteEditor({
  products,
  kits,
  customers,
  templates,
  initial,
  quoteNumber,
  minimumMargin,
  onClose,
  onSave,
}: {
  products: CatalogueProduct[];
  kits: EditorKit[];
  customers: CustomerRow[];
  templates: SalesQuoteTemplate[];
  initial: QuoteInput;
  quoteNumber?: string;
  minimumMargin: number;
  onClose: () => void;
  onSave: (input: QuoteInput) => Promise<void>;
}) {
  const [input, setInput] = useState<QuoteInput>(() => {
    if (initial.customerName || initial.lines.length || initial.templateId) return initial;
    const defaultTemplate = templates.find((template) => template.isDefault);
    return defaultTemplate ? quoteInputFromTemplate(defaultTemplate, products, customers) : initial;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogSectionId, setCatalogSectionId] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const catalogueIndex = useMemo(() => buildCatalogueIndex(products), [products]);
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const kitById = useMemo(() => new Map(kits.map((k) => [k.productId, k])), [kits]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const lastAdded = useRef<{ productId: string; sectionId: string | null } | null>(null);
  const [focusLine, setFocusLine] = useState<{ index: number; nonce: number } | null>(null);
  const [draftPreviewOpen, setDraftPreviewOpen] = useState(false);
  const linesPreview = input.lines.map((line) => {
    const product = productById.get(line.productId);
    const unit = line.unitPrice ?? product?.price ?? 0;
    const discount = (1 - line.discountPercent / 100) * (1 - input.discountPercent / 100);
    const gross = unit * line.quantity * discount;
    const rate = product?.taxRate ?? 0;
    const inclusive = product?.isTaxInclusive !== false;
    // A kit is taxed and costed from what is in it, as the server will do when it is saved.
    const kit = kitById.get(line.productId);
    const split = kit
      ? kitTax(gross, line.quantity, kit, inclusive)
      : {
          net: inclusive && rate > 0 ? gross / (1 + rate / 100) : gross,
          tax: inclusive && rate > 0 ? gross - gross / (1 + rate / 100) : (gross * rate) / 100,
        };
    const unitCost = kit ? kitCost(kit) : (product?.costPrice ?? 0);
    const { net, tax } = split;
    return {
      line,
      product,
      net,
      tax,
      total: net + tax,
      cost: unitCost * line.quantity,
      grossProfit: net - unitCost * line.quantity,
      grossMarginPercent: net > 0 ? ((net - unitCost * line.quantity) / net) * 100 : 0,
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
  /** Adds items in one change, merging into lines that already hold the same item. */
  const addEntries = (entries: CatalogueEntry[]) => {
    if (entries.length === 0) return;
    setInput((current) => {
      let lines = current.lines;
      for (const entry of entries) {
        const product = productById.get(entry.productId);
        if (!product) continue;
        lines = addCatalogueEntry<QuoteLineInput>(
          lines,
          entry,
          (e) => ({
            sectionId: e.sectionId,
            productId: e.productId,
            quantity: e.quantity,
            // The catalogue price shows at once, then the price lists' answer replaces it.
            unitPrice: e.unitPrice ?? product.price,
            priceMode: e.unitPrice === null ? 'catalog' : 'manual',
            discountPercent: e.discountPercent,
          }),
          (line) => line.priceMode === 'manual',
        ).lines;
      }
      return { ...current, lines };
    });
    const last = entries[entries.length - 1]!;
    lastAdded.current = { productId: last.productId, sectionId: last.sectionId };
  };
  /** After the catalogue closes, takes the person to the last item they added. */
  const showLastAdded = () => {
    const last = lastAdded.current;
    lastAdded.current = null;
    if (!last) return;
    const index = lastIndexOfProduct(input.lines, last.productId, last.sectionId);
    if (index >= 0) setFocusLine((current) => ({ index, nonce: (current?.nonce ?? 0) + 1 }));
  };
  /** How much of a product a place already holds, or null. */
  const heldIn = (productId: string, slot: string | null) => {
    const here = input.lines.filter(
      (line) => line.productId === productId && (line.sectionId ?? null) === slot,
    );
    return here.length === 0 ? null : here.reduce((sum, line) => sum + line.quantity, 0);
  };
  const placeName = (slot: string | null) =>
    slot === null
      ? 'the individual items'
      : `section ${(input.sections ?? []).find((x) => x.id === slot)?.title ?? ''}`.trim();
  const patchLine = (index: number, patch: Partial<QuoteLineInput>) =>
    setField(
      'lines',
      input.lines.map((line, lineIndex) => (lineIndex === index ? { ...line, ...patch } : line)),
    );
  const { traces, problems } = useQuotePricePreview(input, setInput);
  const guards = useQuoteGuardPreview(input);
  const [swap, setSwap] = useState<{
    plan: SwapPlan;
    from: SalesQuoteTemplate | null;
    to: SalesQuoteTemplate | null;
  } | null>(null);
  /** Templates a quote can be switched to; the one it already has stays listed even if archived. */
  const templateOptions = templates.filter(
    (template) => template.status === 'active' || template.id === input.templateId,
  );
  const selectTemplate = (templateId: string) => {
    if (templateId === (input.templateId ?? '')) return;
    const from = templates.find((candidate) => candidate.id === input.templateId) ?? null;
    const to = templates.find((candidate) => candidate.id === templateId) ?? null;
    const plan = planTemplateSwap(input, from, to, (id) => productById.get(id)?.price);
    if (plan.kind !== 'none') {
      setSwap({ plan, from, to });
      return;
    }
    // Nothing on the form to replace. A form with no customer yet also takes the template's.
    if (!input.customerName && !input.customerId) {
      setInput(to ? quoteInputFromTemplate(to, products, customers) : newQuoteInput());
      return;
    }
    setInput(plan.apply(false));
  };

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
        {(templateOptions.length > 0 || input.templateId) && (
          <label className="block text-sm font-medium text-fg">
            {quoteNumber ? 'Template' : 'Start from a template'}
            <select
              value={input.templateId ?? ''}
              onChange={(event) => selectTemplate(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
            >
              <option value="">{quoteNumber ? 'No template' : 'Blank quote'}</option>
              {templateOptions.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                  {template.isDefault ? ' · Default' : ''}
                  {template.status === 'archived' ? ' · Archived' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {swap && (
          <TemplateSwapDialog
            plan={swap.plan}
            fromName={swap.from?.name ?? null}
            toName={swap.to?.name ?? null}
            nameOf={(id) => productById.get(id)?.name ?? 'Unknown item'}
            onClose={() => setSwap(null)}
            onConfirm={(keepAdditions) => {
              setInput(swap.plan.apply(keepAdditions));
              setSwap(null);
            }}
          />
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
          <label className="text-sm font-medium text-fg">
            Payment terms
            <input
              value={input.paymentTerms ?? ''}
              onChange={(event) => setField('paymentTerms', event.target.value)}
              placeholder="e.g. 50% deposit, balance on delivery"
              className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
            />
          </label>
        </section>

        <section className="space-y-3 rounded-xl border border-line bg-surface-raised p-3 sm:p-4">
          <header>
            <h3 className="font-semibold text-fg-strong">Quote items</h3>
            <p className="text-xs text-fg-muted">
              Individual items print one by one. A section prints as its title with its total, or
              with its items listed under it when you keep it expanded.
            </p>
          </header>
          <QuoteLayoutBoard
            noun="quote"
            sections={input.sections ?? []}
            lines={input.lines}
            onChange={(next) => setInput((current) => ({ ...current, ...next }))}
            focusLine={focusLine}
            onBulkAdd={() => {
              lastAdded.current = null;
              setBulkOpen(true);
            }}
            lineSearchText={(line) => {
              const product = productById.get(line.productId);
              return `${product?.name ?? ''} ${product?.sku ?? ''} ${product?.stockCode ?? ''}`;
            }}
            quickAdd={(slot) => (
              <QuickAdd
                index={catalogueIndex}
                currency={input.currency}
                destination={placeName(slot)}
                countHere={() => input.lines.filter((l) => (l.sectionId ?? null) === slot).length}
                quantityHere={(productId) => heldIn(productId, slot)}
                onAdd={(entry) => addEntries([{ ...entry, sectionId: slot }])}
              />
            )}
            onBrowse={(sectionId) => {
              lastAdded.current = null;
              setCatalogSectionId(sectionId);
              setCatalogOpen(true);
            }}
            lineName={(line) => productById.get(line.productId)?.name ?? 'item'}
            sectionTotal={(sectionId) =>
              money(
                linesPreview
                  .filter((entry) => entry.line.sectionId === sectionId)
                  .reduce((sum, entry) => sum + entry.total, 0),
                input.currency,
              )
            }
            minWidth={1040}
            columns={9}
            head={
              <>
                <th className="p-3">Item</th>
                <th className="p-3">Qty</th>
                <th className="p-3">Unit price</th>
                <th className="p-3">Disc %</th>
                <th className="p-3 text-right">Cost</th>
                <th className="p-3 text-right">Gross profit</th>
                <th className="p-3 text-right">Margin</th>
                <th className="p-3 text-right">Amount</th>
              </>
            }
            renderCells={(line, index) => {
              const entry = linesPreview[index]!;
              return (
                <>
                  <td className="p-3">
                    <div className="font-medium text-fg-strong">{entry.product?.name}</div>
                    <div className="text-xs text-fg-muted">
                      {entry.product?.sku} · tax {entry.product?.taxRate ?? 0}%
                    </div>
                  </td>
                  <td className="p-3">
                    <QuantityInput
                      label={`Quantity of ${entry.product?.name ?? 'item'}`}
                      value={line.quantity}
                      onChange={(value) => patchLine(index, { quantity: Number(value) })}
                    />
                  </td>
                  <td className="p-3">
                    <input
                      aria-label={`Unit price of ${entry.product?.name ?? 'item'}`}
                      type="number"
                      min="0"
                      step="0.0001"
                      value={line.unitPrice ?? ''}
                      onChange={(event) =>
                        patchLine(index, {
                          unitPrice: Number(event.target.value),
                          priceMode: 'manual',
                        })
                      }
                      className="w-28 rounded-md border border-line bg-surface px-2 py-1 text-fg-strong"
                    />
                    <QuoteLinePriceNote
                      mode={line.priceMode ?? (line.unitPrice != null ? 'manual' : 'catalog')}
                      trace={traces[index]}
                      problem={problems[index]}
                      guard={guards[index]}
                      onUseLists={() => patchLine(index, { priceMode: 'catalog' })}
                    />
                  </td>
                  <td className="p-3">
                    <input
                      aria-label={`Discount percent of ${entry.product?.name ?? 'item'}`}
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
                    {money(entry.cost, input.currency)}
                  </td>
                  <td
                    className={`p-3 text-right text-xs font-semibold ${entry.grossProfit < 0 ? 'text-red-700' : 'text-fg-strong'}`}
                  >
                    {money(entry.grossProfit, input.currency)}
                  </td>
                  <td
                    className={`p-3 text-right text-xs font-semibold ${entry.grossMarginPercent < minimumMargin ? 'text-amber-800' : 'text-emerald-700'}`}
                  >
                    {entry.grossMarginPercent.toFixed(1)}%
                  </td>
                  <td className="p-3 text-right font-mono font-semibold text-fg-strong">
                    {money(entry.total, input.currency)}
                  </td>
                  <td className="p-3">
                    <button
                      type="button"
                      onClick={() =>
                        setField(
                          'lines',
                          input.lines.filter((item) => item !== line),
                        )
                      }
                      className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded text-fg-muted hover:bg-red-50 hover:text-red-700"
                      aria-label={`Remove ${entry.product?.name ?? 'item'}`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </td>
                </>
              );
            }}
          />
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
            <QuoteCoupons input={input} onCodes={(codes) => setField('couponCodes', codes)} />
            <label className="flex items-center gap-2 text-sm font-medium text-fg sm:col-span-2">
              <input
                type="checkbox"
                checked={input.showBillingAddress !== false}
                onChange={(event) => setField('showBillingAddress', event.target.checked)}
              />
              Include Bill To information on the quote document
            </label>
            {input.showBillingAddress !== false && (
              <label className="text-sm font-medium text-fg sm:col-span-2">
                Bill To information
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
            )}
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
            <label className="text-sm font-medium text-fg">
              Payment details for customer document
              <textarea
                rows={3}
                value={input.paymentDetails ?? ''}
                onChange={(event) => setField('paymentDetails', event.target.value)}
                placeholder="Bank transfer, mobile-money, deposit instructions…"
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
            <label className="text-sm font-medium text-fg">
              Terms and conditions
              <textarea
                rows={3}
                value={input.termsAndConditions ?? ''}
                onChange={(event) => setField('termsAndConditions', event.target.value)}
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
            type="button"
            disabled={input.lines.length === 0}
            onClick={() => setDraftPreviewOpen(true)}
            className="rounded-lg border border-indigo-300 px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 dark:text-indigo-300"
          >
            Preview quote
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
      {catalogOpen && (
        <CataloguePicker
          title="Product catalogue"
          index={catalogueIndex}
          currency={input.currency}
          destination={placeName(catalogSectionId)}
          priceHint="Leave the price empty to use the price lists. A price you type is kept as a manual price on the line."
          quantityHere={(productId) => heldIn(productId, catalogSectionId)}
          onAdd={(entries) =>
            addEntries(entries.map((entry) => ({ ...entry, sectionId: catalogSectionId })))
          }
          onClose={() => {
            setCatalogOpen(false);
            setCatalogSectionId(null);
            showLastAdded();
          }}
        />
      )}
      {bulkOpen && (
        <BulkAddDialog
          noun="quote"
          index={catalogueIndex}
          places={[
            { id: null, label: 'The individual items' },
            ...(input.sections ?? []).map((x) => ({ id: x.id, label: `Section ${x.title}` })),
          ]}
          initialSlot={null}
          onAdd={(entries) => {
            addEntries(entries);
            setBulkOpen(false);
            showLastAdded();
          }}
          onClose={() => setBulkOpen(false)}
        />
      )}
      {draftPreviewOpen && (
        <DraftQuotePreview
          input={input}
          lines={linesPreview}
          subtotal={subtotal}
          tax={tax}
          total={total}
          quoteNumber={quoteNumber}
          onClose={() => setDraftPreviewOpen(false)}
        />
      )}
    </Modal>
  );
}

function DraftQuotePreview({
  input,
  lines,
  subtotal,
  tax,
  total,
  quoteNumber,
  onClose,
}: {
  input: QuoteInput;
  lines: {
    line: QuoteLineInput;
    product: CatalogueProduct | undefined;
    total: number;
  }[];
  subtotal: number;
  tax: number;
  total: number;
  quoteNumber?: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-backdrop/80 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Customer quote preview"
        className="flex max-h-[94dvh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="font-semibold text-fg-strong">Customer quote preview</h2>
            <p className="text-xs text-fg-muted">
              Individual items print one by one. A section prints as its title and total, with its
              items listed under it when it is kept expanded. Cost, margins, internal notes, and
              delivery address stay private.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close quote preview"
            className="rounded-lg p-2 text-fg-muted hover:bg-hover"
          >
            <X className="h-5 w-5" />
          </button>
        </header>
        <article className="overflow-y-auto bg-white p-6 text-slate-900 sm:p-10">
          <header className="flex flex-col justify-between gap-6 border-b-2 border-indigo-700 pb-5 sm:flex-row">
            <div>
              <p className="text-xs font-semibold tracking-[0.2em] text-indigo-700 uppercase">
                Quotation
              </p>
              <h1 className="mt-2 text-2xl font-bold">{quoteNumber ?? 'Draft quote'}</h1>
              <p className="mt-2 text-sm text-slate-600">
                Prepared for {input.customerName || 'Customer'}
              </p>
              {input.customerEmail && (
                <p className="text-sm text-slate-600">{input.customerEmail}</p>
              )}
              {input.customerReference && (
                <p className="mt-2 text-xs text-slate-600">Reference: {input.customerReference}</p>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2 self-start text-sm">
              <dt className="text-slate-500">Issue date</dt>
              <dd className="text-right">{new Date().toLocaleDateString()}</dd>
              <dt className="text-slate-500">Valid until</dt>
              <dd className="text-right">
                {input.validUntil
                  ? new Date(`${input.validUntil}T12:00:00`).toLocaleDateString()
                  : '—'}
              </dd>
              <dt className="text-slate-500">Currency</dt>
              <dd className="text-right">{input.currency}</dd>
            </dl>
          </header>

          {input.showBillingAddress === true &&
            Object.values(input.billingAddress ?? {}).some((value) => value.trim().length > 0) && (
              <section className="py-5">
                <h3 className="text-xs font-bold tracking-wider text-indigo-700 uppercase">
                  Bill to
                </h3>
                <p className="mt-1 font-semibold">{input.customerName || 'Customer'}</p>
                <p className="text-sm text-slate-600">
                  {[
                    input.billingAddress?.street,
                    input.billingAddress?.city,
                    input.billingAddress?.countyOrState,
                    input.billingAddress?.postalCode,
                    input.billingAddress?.country,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </p>
              </section>
            )}

          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="bg-indigo-700 text-white">
                <th className="p-3">Description</th>
                <th className="p-3 text-right">Qty</th>
                <th className="p-3 text-right">Unit price</th>
                <th className="p-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines
                .filter((entry) => !entry.line.sectionId)
                .map((entry, index) => (
                  <tr
                    key={`draft-item-${entry.line.productId}-${index}`}
                    className="border-b border-slate-200"
                  >
                    <td className="p-3">
                      <p className="font-semibold">{entry.product?.name ?? 'Quote item'}</p>
                      <p className="text-xs text-slate-500">{entry.product?.sku ?? ''}</p>
                    </td>
                    <td className="p-3 text-right">{entry.line.quantity}</td>
                    <td className="p-3 text-right">
                      {money(entry.line.unitPrice ?? entry.product?.price ?? 0, input.currency)}
                    </td>
                    <td className="p-3 text-right">{money(entry.total, input.currency)}</td>
                  </tr>
                ))}
              {input.sections.flatMap((section) => {
                const inSection = lines.filter((entry) => entry.line.sectionId === section.id);
                const sectionTotal = inSection.reduce((sum, entry) => sum + entry.total, 0);
                return [
                  <tr key={section.id} className="border-b border-slate-200 bg-slate-50">
                    <td className="p-3" colSpan={3}>
                      <p className="font-semibold">{section.title}</p>
                      {section.description && (
                        <p className="mt-1 text-xs text-slate-500">{section.description}</p>
                      )}
                    </td>
                    <td className="p-3 text-right font-semibold">
                      {money(sectionTotal, input.currency)}
                    </td>
                  </tr>,
                ];
              })}
            </tbody>
          </table>

          <dl className="mt-6 ml-auto max-w-xs space-y-2 text-sm">
            <PreviewTotal label="Subtotal" value={subtotal} currency={input.currency} />
            <PreviewTotal label="Tax" value={tax} currency={input.currency} />
            <PreviewTotal
              label="Shipping"
              value={Number(input.shippingFee)}
              currency={input.currency}
            />
            <div className="flex justify-between border-t-2 border-indigo-700 pt-3 text-base font-bold">
              <dt>Total</dt>
              <dd>{money(total, input.currency)}</dd>
            </div>
          </dl>

          {input.publicNotes && <PreviewText title="Notes" text={input.publicNotes} />}
          {input.paymentDetails && (
            <PreviewText title="Payment details" text={input.paymentDetails} />
          )}
          {input.paymentTerms && <PreviewText title="Payment terms" text={input.paymentTerms} />}
          {input.termsAndConditions && (
            <PreviewText title="Terms and conditions" text={input.termsAndConditions} />
          )}
          <p className="mt-8 border-t border-slate-200 pt-4 text-xs text-slate-500">
            This quotation is subject to the stated validity and terms. It is not a tax invoice or
            confirmation of payment.
          </p>
        </article>
      </section>
    </div>
  );
}

function PreviewTotal({
  label,
  value,
  currency,
}: {
  label: string;
  value: number;
  currency: string;
}) {
  return (
    <div className="flex justify-between text-slate-600">
      <dt>{label}</dt>
      <dd>{money(value, currency)}</dd>
    </div>
  );
}

function PreviewText({ title, text }: { title: string; text: string }) {
  return (
    <section className="mt-6 border-t border-slate-200 pt-4">
      <h3 className="text-xs font-bold tracking-wider text-indigo-700 uppercase">{title}</h3>
      <p className="mt-2 text-sm whitespace-pre-wrap text-slate-700">{text}</p>
    </section>
  );
}

/** Where a workflow-approved quote stands, in a line under its status. */
function ApprovalNote({
  quote,
}: {
  quote: Pick<SalesQuote, 'approvalManagedBy' | 'approvalStatus'>;
}) {
  if (quote.approvalManagedBy !== 'workflow') return null;
  const text =
    quote.approvalStatus === 'pending'
      ? 'Waiting for approval in the Approvals inbox'
      : quote.approvalStatus === 'rejected'
        ? 'Approval refused: reopen it from My requests'
        : quote.approvalStatus === 'draft'
          ? 'Reopened: change it or send it for approval again'
          : null;
  return text ? <p className="mt-1 text-xs text-fg-muted">{text}</p> : null;
}

function QuoteDetails({
  quote,
  canApprove,
  canDelete,
  canRevise,
  onTemplate,
  busy,
  onClose,
  onApprove,
  onResubmit,
  onAccept,
  onReject,
  onCancel,
  onRevise,
  onConvert,
  onPreview,
}: {
  quote: SalesQuote;
  canApprove: boolean;
  canDelete: boolean;
  canRevise: boolean;
  /** Make a template from this quote; offered to anyone who may create quotes. */
  onTemplate: () => void;
  busy: boolean;
  onClose: () => void;
  onApprove: () => void;
  onResubmit: () => void;
  onAccept: () => void;
  onReject: () => void;
  onCancel: () => void;
  onRevise: () => void;
  onConvert: () => void;
  onPreview: () => void;
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
        {quote.showBillingAddress &&
          Object.values(quote.billingAddress ?? {}).some((value) => value.trim().length > 0) && (
            <Summary
              label="Bill to"
              value={quote.customerName}
              detail={[
                quote.billingAddress.street,
                quote.billingAddress.city,
                quote.billingAddress.countyOrState,
                quote.billingAddress.postalCode,
                quote.billingAddress.country,
              ]
                .filter(Boolean)
                .join(', ')}
            />
          )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Summary
            label="Ship to (internal quote detail)"
            value={quote.customerName}
            detail={
              [
                quote.deliveryAddress.street,
                quote.deliveryAddress.city,
                quote.deliveryAddress.countyOrState,
                quote.deliveryAddress.postalCode,
                quote.deliveryAddress.country,
              ]
                .filter(Boolean)
                .join(', ') || 'No delivery address saved'
            }
          />
          <Summary
            label="Payment and terms"
            value={quote.paymentMethod.replaceAll('_', ' ')}
            detail={
              [quote.paymentTerms, quote.paymentDetails].filter(Boolean).join(' · ') ||
              'No payment details configured'
            }
          />
        </div>
        {quote.termsAndConditions && (
          <div className="rounded-xl border border-line bg-surface p-4">
            <h3 className="font-semibold text-fg-strong">Terms and conditions</h3>
            <p className="mt-2 text-sm whitespace-pre-wrap text-fg-muted">
              {quote.termsAndConditions}
            </p>
          </div>
        )}
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
              {quote.lines
                .filter((line) => !line.sectionId)
                .map((line) => {
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
                      <td className="p-3 text-right font-semibold">{margin.toFixed(1)}%</td>
                      <td className="p-3 text-right font-semibold text-fg-strong">
                        {money(Number(line.lineAmount), quote.currency)}
                      </td>
                    </tr>
                  );
                })}
              {quote.sections.flatMap((section) => {
                const sectionLines = quote.lines.filter((line) => line.sectionId === section.id);
                const sectionGross = sectionLines.reduce(
                  (sum, line) => sum + Number(line.lineAmount),
                  0,
                );
                return [
                  <tr key={`section-${section.id}`} className="bg-surface-raised">
                    <td colSpan={6} className="p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <strong className="text-fg-strong">{section.title}</strong>
                          {section.description && (
                            <p className="text-xs text-fg-muted">{section.description}</p>
                          )}
                        </div>
                        <span className="font-mono font-bold text-fg-strong">
                          Section gross total {money(sectionGross, quote.currency)}
                        </span>
                      </div>
                    </td>
                  </tr>,
                  ...sectionLines.map((line) => {
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
                  }),
                ];
              })}
            </tbody>
          </table>
        </section>
        {quote.internalNotes && (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
            <strong>Internal:</strong> {quote.internalNotes}
          </p>
        )}
        {quote.publicNotes && (
          <p className="rounded-lg border border-line bg-surface p-3 text-sm text-fg">
            <strong>Customer note:</strong> {quote.publicNotes}
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
          <ActionButton
            onClick={onPreview}
            disabled={busy}
            icon={<FilePlus2 className="h-4 w-4" />}
          >
            Preview customer PDF
          </ActionButton>
          {quote.approvalManagedBy === 'workflow' && quote.approvalStatus === 'draft' && (
            <ActionButton
              onClick={onResubmit}
              disabled={busy}
              icon={<BadgeCheck className="h-4 w-4" />}
            >
              Send for approval again
            </ActionButton>
          )}
          {quote.status === 'pending_approval' &&
            canApprove &&
            quote.approvalManagedBy !== 'workflow' && (
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
          {canRevise && (
            <ActionButton onClick={onTemplate} disabled={busy} icon={<Files className="h-4 w-4" />}>
              Create template from this quote
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

function PdfPreview({ base64, onClose }: { base64: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-backdrop/80 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Customer quote PDF preview"
        className="flex h-[94dvh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-line p-3">
          <h2 className="font-semibold text-fg-strong">Customer quotation preview</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="rounded-lg p-2 text-fg-muted hover:bg-hover"
          >
            <X className="h-5 w-5" />
          </button>
        </header>
        <iframe
          title="Quote PDF preview"
          src={`data:application/pdf;base64,${base64}`}
          className="min-h-0 flex-1 bg-white"
        />
      </section>
    </div>
  );
}
