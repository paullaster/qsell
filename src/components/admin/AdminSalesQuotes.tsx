'use client';

import { Suspense, use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, RefreshCw, Settings2, Files, LayoutList } from 'lucide-react';
import type { CatalogueProduct } from '@/lib/catalogue-entry';

import { downloadPdfBase64 } from '@/lib/downloadPdf';
import {
  approveSalesQuoteAction,
  resubmitSalesQuoteApprovalAction,
  cancelSalesQuoteAction,
  convertSalesQuoteToOrderAction,
  createSalesQuoteAction,
  generateSalesQuotePdfAction,
  getSalesQuoteAction,
  getSalesQuoteEditorDataAction,
  sendSalesQuoteAction,
  reviseSalesQuoteAction,
  respondToSalesQuoteAction,
  updateSalesQuoteAction,
  updateSalesQuoteSettingsAction,
  type EditorKit,
} from '@/server/domains/quotes/actions';
import type {
  QuoteInput,
  QuoteListPage,
  QuoteListRow,
  QuoteSearchHit,
  SalesQuote,
} from '@/server/domains/quotes/service';
import { QuotesTable } from './quotes/QuotesTable';
import { AdminSalesQuoteTemplates } from './AdminSalesQuoteTemplates';
import { AdminSectionTemplates } from './AdminSectionTemplates';

import type { QuoteStatusFilter } from '@/lib/quote-statuses';
import { getQuoteFormAction, startNewQuoteAction } from '@/server/domains/quotes/form-actions';
import { Modal } from '@/components/ui/Modal';
import { QuoteEditor } from './quotes/QuoteEditor';
import { PdfPreview, QuoteDetails } from './quotes/QuoteDetails';

import { unwrapQuoteAction, type QuoteActionResult } from '@/server/domains/quotes/action-result';

interface EditorData {
  products: CatalogueProduct[];
  kits: EditorKit[];
  settings: {
    minimumGrossMarginPercent: string;
    nextQuoteNumber: number;
  };
}

/** Stands in for the quotes list while its first page is on its way. */
function TableSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading quotes"
      className="space-y-2 rounded-xl border border-line bg-surface-raised p-4"
    >
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="h-10 animate-pulse rounded-lg bg-surface-sunken" />
      ))}
    </div>
  );
}

export function AdminSalesQuotes({
  quotesPage,
  query,
  status,
  capabilitiesPromise,
}: {
  /** The first page of the list for the search and status in the address. */
  quotesPage: Promise<QuoteActionResult<QuoteListPage>>;
  query: string;
  status: QuoteStatusFilter;
  capabilitiesPromise: Promise<{
    canCreate: boolean;
    canUpdate: boolean;
    canApprove: boolean;
    canDelete: boolean;
    canConfigure: boolean;
  }>;
}) {
  const capabilities = use(capabilitiesPromise);
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'quotes' | 'templates' | 'sections'>('quotes');
  /** Shows a tab; the template screens need the editor's data, so asking for it starts here. */
  const selectTab = (tab: 'quotes' | 'templates' | 'sections') => {
    setActiveTab(tab);
    if (tab !== 'quotes') void ensureEditorData();
  };
  // What the editor and the template screens need (the catalogue, kits, settings) is fetched when
  // one of them is first opened, not when the list is: the list never waits for it.
  const [editorData, setEditorData] = useState<EditorData | null>(null);
  const [loadingEditorData, setLoadingEditorData] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  /** The quote being edited (null for a new one) and the form the editor starts from. */
  const [editing, setEditing] = useState<{ id: string; quoteNumber: string } | null>(null);
  const [startForm, setStartForm] = useState<QuoteInput | null>(null);
  const [details, setDetails] = useState<SalesQuote | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewPdf, setPreviewPdf] = useState<string | null>(null);
  /** A quote someone chose to make a template from: the Templates tab opens its editor on it. */
  const [templateFrom, setTemplateFrom] = useState<QuoteSearchHit | null>(null);
  const startTemplate = (quote: QuoteListRow) => {
    setTemplateFrom({
      id: quote.id,
      quoteNumber: quote.quoteNumber,
      customerName: quote.customerName,
      customerEmail: quote.customerEmail,
      status: quote.status,
      currency: quote.currency,
      totalAmount: Number(quote.totalAmount),
      validUntil: quote.validUntil ? new Date(quote.validUntil).toISOString() : null,
      expired: quote.expired,
    });
    setDetails(null);
    selectTab('templates');
  };
  const [marginFloor, setMarginFloor] = useState(0);

  /** Loads the editor's data once, the first time something needs it. */
  const ensureEditorData = async (): Promise<EditorData | null> => {
    if (editorData !== null) return editorData;
    try {
      setLoadingEditorData(true);
      const data = await getSalesQuoteEditorDataAction();
      setEditorData(data);
      setMarginFloor(Number(data.settings.minimumGrossMarginPercent));
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the quote editor.');
      return null;
    } finally {
      setLoadingEditorData(false);
    }
  };

  const refresh = () => router.refresh();
  const message = error ?? notice;

  const openCreate = async () => {
    try {
      setError(null);
      const [started, data] = await Promise.all([startNewQuoteAction(), ensureEditorData()]);
      if (!started.ok) throw new Error(started.error);
      if (data === null) return;
      setEditing(null);
      setStartForm(started.data);
      setEditorOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start a quote.');
    }
  };

  const openEdit = async (id: string) => {
    try {
      setError(null);
      const [loaded, data] = await Promise.all([getQuoteFormAction(id), ensureEditorData()]);
      if (!loaded.ok) throw new Error(loaded.error);
      if (data === null) return;
      setEditing({ id, quoteNumber: loaded.data.quoteNumber });
      setStartForm(loaded.data.form);
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

  const handleDownload = async (quote: QuoteListRow) => {
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

  /** The screen under the tabs: the list, or one of the template screens once its data is in. */
  const tabBody = () => {
    if (activeTab === 'quotes') {
      return (
        <Suspense fallback={<TableSkeleton />}>
          <QuotesTable
            firstPage={quotesPage}
            query={query}
            status={status}
            permissions={capabilities}
            busyId={busyId}
            handlers={{
              view: (row) => void getSalesQuoteAction(row.id).then(setDetails),
              edit: (row) => void openEdit(row.id),
              template: startTemplate,
              download: (row) => void handleDownload(row),
              approve: (row) =>
                void withAction(
                  row.id,
                  () => approveSalesQuoteAction(row.id).then(unwrapQuoteAction),
                  `${row.quoteNumber} approved.`,
                ),
              email: (row) =>
                void withAction(
                  row.id,
                  () => sendSalesQuoteAction(row.id).then(unwrapQuoteAction),
                  `${row.quoteNumber} emailed to ${row.customerEmail ?? 'customer'}.`,
                ),
              convert: (row) =>
                void withAction(
                  row.id,
                  async () => {
                    const order = unwrapQuoteAction(await convertSalesQuoteToOrderAction(row.id));
                    setNotice(`Converted to order ${order?.orderNumber ?? ''}.`);
                  },
                  `${row.quoteNumber} converted to an order.`,
                ),
            }}
          />
        </Suspense>
      );
    }
    if (editorData === null) {
      return (
        <p
          role="status"
          className="rounded-xl border border-line bg-surface-raised p-6 text-sm text-fg-muted"
        >
          {loadingEditorData ? 'Loading…' : 'Could not load this screen. Try again.'}
        </p>
      );
    }
    if (activeTab === 'sections') {
      return (
        <AdminSectionTemplates
          products={editorData.products}
          canCreate={capabilities.canCreate}
          canUpdate={capabilities.canUpdate}
          canDelete={capabilities.canDelete}
          onMessage={setNotice}
          onError={setError}
        />
      );
    }
    return (
      <AdminSalesQuoteTemplates
        products={editorData.products}
        canCreate={capabilities.canCreate}
        canUpdate={capabilities.canUpdate}
        canDelete={capabilities.canDelete}
        onMessage={setNotice}
        onError={setError}
        fromQuote={templateFrom}
        onFromQuoteHandled={() => setTemplateFrom(null)}
      />
    );
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
              onClick={() =>
                void ensureEditorData().then((data) => data !== null && setSettingsOpen(true))
              }
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
              onClick={() => void openCreate()}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              <Plus className="h-4 w-4" /> New quote
            </button>
          )}
        </div>
      </header>

      {message !== null && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${error === null ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-red-300 bg-red-50 text-red-800'}`}
          role={error === null ? 'status' : 'alert'}
        >
          {message}
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
          onClick={() => selectTab('quotes')}
          className={`border-b-2 px-4 py-2.5 text-sm font-semibold ${activeTab === 'quotes' ? 'border-indigo-600 text-indigo-700 dark:text-indigo-300' : 'border-transparent text-fg-muted hover:text-fg-strong'}`}
        >
          Quotes
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'templates'}
          onClick={() => selectTab('templates')}
          className={`inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold ${activeTab === 'templates' ? 'border-indigo-600 text-indigo-700 dark:text-indigo-300' : 'border-transparent text-fg-muted hover:text-fg-strong'}`}
        >
          <Files className="h-4 w-4" /> Templates
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'sections'}
          onClick={() => selectTab('sections')}
          className={`inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold ${activeTab === 'sections' ? 'border-indigo-600 text-indigo-700 dark:text-indigo-300' : 'border-transparent text-fg-muted hover:text-fg-strong'}`}
        >
          <LayoutList className="h-4 w-4" aria-hidden /> Section templates
        </button>
      </div>

      {tabBody()}

      {editorOpen && editorData !== null && startForm !== null && (
        <QuoteEditor
          products={editorData.products}
          initial={startForm}
          quoteNumber={editing?.quoteNumber}
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

      {previewPdf !== null && (
        <PdfPreview base64={previewPdf} onClose={() => setPreviewPdf(null)} />
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
  return await respondToSalesQuoteAction(id, accepted).then(unwrapQuoteAction);
}
