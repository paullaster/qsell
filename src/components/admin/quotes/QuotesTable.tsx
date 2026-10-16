'use client';

import { use, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  BadgeCheck,
  Clock3,
  Download,
  Eye,
  Files,
  MailWarning,
  Search,
  Send,
  ShoppingCart,
} from 'lucide-react';
import { LookupAutocomplete } from '@/components/ui/autocomplete/LookupAutocomplete';
import {
  approvalNote,
  missesMarginFloor,
  money,
  quoteBadge,
  rowActions,
  type BadgeTone,
  type QuoteRowPermissions,
} from '@/lib/quote-display';
import { statusFilterLabel, type QuoteStatusFilter } from '@/lib/quote-statuses';
import type { QuoteActionResult } from '@/server/domains/quotes/action-result';
import { listSalesQuotesPageAction } from '@/server/domains/quotes/actions';
import type { QuoteListPage, QuoteListRow } from '@/server/domains/quotes/service';

export interface QuoteRowHandlers {
  view: (row: QuoteListRow) => void;
  edit: (row: QuoteListRow) => void;
  template: (row: QuoteListRow) => void;
  download: (row: QuoteListRow) => void;
  approve: (row: QuoteListRow) => void;
  email: (row: QuoteListRow) => void;
  convert: (row: QuoteListRow) => void;
}

const SEARCH_PAUSE_MS = 300;

const TONES: Record<BadgeTone, string> = {
  warning: 'bg-amber-100 text-amber-900',
  success: 'bg-emerald-100 text-emerald-800',
  danger: 'bg-red-100 text-red-800',
  neutral: 'bg-surface-sunken text-fg',
};

const iconButton =
  'inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-md hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-40';

/** The address of the quotes page for a search and a status; the defaults are left out. */
function listAddress(query: string, status: QuoteStatusFilter): string {
  const params = new URLSearchParams();
  if (query !== '') params.set('q', query);
  if (status !== 'all') params.set('status', status);
  const text = params.toString();
  return text === '' ? '/admin/quotes' : `/admin/quotes?${text}`;
}

/**
 * The quotes list, one page at a time. The search and the status live in the page's address, so
 * the server fetches the page they ask for (nothing is filtered here) and a link to a filtered
 * list works. Further pages are fetched on request and added below, never the whole list.
 */
export function QuotesTable({
  firstPage,
  query,
  status,
  permissions,
  busyId,
  handlers,
}: {
  firstPage: Promise<QuoteActionResult<QuoteListPage>>;
  query: string;
  status: QuoteStatusFilter;
  permissions: QuoteRowPermissions;
  busyId: string | null;
  handlers: QuoteRowHandlers;
}) {
  const router = useRouter();
  const result = use(firstPage);
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState(query);
  const [more, setMore] = useState<QuoteListRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(result.ok ? result.data.nextCursor : null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [seen, setSeen] = useState(result);

  // A new first page (a different search or status, or a refresh) replaces what was added below.
  if (seen !== result) {
    setSeen(result);
    setMore([]);
    setCursor(result.ok ? result.data.nextCursor : null);
    setMoreError(null);
  }

  // Searching waits for a pause in typing, then asks the server for the new first page.
  useEffect(() => {
    if (text === query) return;
    const timer = setTimeout(() => {
      startTransition(() => router.replace(listAddress(text.trim(), status)));
    }, SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [text, query, status, router]);

  const loadMore = async () => {
    if (cursor === null || loadingMore) return;
    try {
      setLoadingMore(true);
      setMoreError(null);
      const next = await listSalesQuotesPageAction({ query, status, cursor });
      if (!next.ok) throw new Error(next.error);
      setMore((current) => [...current, ...next.data.rows]);
      setCursor(next.data.nextCursor);
    } catch (error) {
      setMoreError(error instanceof Error ? error.message : 'Could not load more quotes.');
    } finally {
      setLoadingMore(false);
    }
  };

  const rows = result.ok ? [...result.data.rows, ...more] : more;
  const filtered = query !== '' || status !== 'all';

  return (
    <section
      className="rounded-xl border border-line bg-surface-raised"
      aria-busy={pending}
      aria-label="Quotes"
    >
      <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <input
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Search quote number, customer, reference…"
            aria-label="Search quotes"
            className="min-h-10 w-full rounded-lg border border-line bg-surface py-2 pr-3 pl-9 text-sm text-fg-strong placeholder:text-fg-subtle focus-visible:outline-2 focus-visible:outline-indigo-500"
          />
        </div>
        <LookupAutocomplete
          source="quote-statuses"
          label="Filter quotes by status"
          hideLabel
          value={status}
          valueLabel={statusFilterLabel(status)}
          clearable={false}
          onChange={(option) => {
            if (option !== null) {
              startTransition(() =>
                router.replace(listAddress(text.trim(), option.id as QuoteStatusFilter)),
              );
            }
          }}
          className="w-full sm:w-56"
        />
      </div>

      {!result.ok && (
        <p
          role="alert"
          className="m-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {result.error}
        </p>
      )}

      {/* A phone shows each quote as a card (the table's rows are stacked), so nothing needs sideways scrolling; the roles keep it a table for screen readers. */}
      <div className={pending ? 'opacity-60' : ''}>
        <table role="table" className="block w-full text-left text-sm md:table">
          <thead role="rowgroup" className="hidden bg-surface text-xs text-fg-muted md:table-header-group">
            <tr role="row">
              <th role="columnheader" className="px-4 py-3">Quote</th>
              <th role="columnheader" className="px-4 py-3">Customer</th>
              <th role="columnheader" className="px-4 py-3 text-right">Total</th>
              <th role="columnheader" className="px-4 py-3 text-right">Gross margin</th>
              <th role="columnheader" className="px-4 py-3">Status</th>
              <th role="columnheader" className="px-4 py-3">Valid until</th>
              <th role="columnheader" className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody role="rowgroup" className="block divide-y divide-line md:table-row-group">
            {rows.length === 0 ? (
              <tr role="row" className="block md:table-row">
                <td role="cell" colSpan={7} className="block px-4 py-12 text-center text-fg-muted md:table-cell">
                  {filtered
                    ? 'No quotes match those filters.'
                    : 'No quotes yet. Create a quote to start the sales workflow.'}
                </td>
              </tr>
            ) : (
              rows.map((quote) => (
                <QuoteRow
                  key={quote.id}
                  quote={quote}
                  permissions={permissions}
                  busy={busyId === quote.id}
                  handlers={handlers}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-3 text-xs text-fg-muted">
        <p role="status" aria-live="polite">
          {String(rows.length)} {rows.length === 1 ? 'quote' : 'quotes'} shown
          {cursor === null ? '' : ', more available'}
        </p>
        {moreError !== null && (
          <p role="alert" className="text-red-700">
            {moreError}
          </p>
        )}
        {cursor !== null && (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="min-h-10 rounded-lg border border-line-strong bg-surface px-4 py-2 text-sm font-medium text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </section>
  );
}

function QuoteRow({
  quote,
  permissions,
  busy,
  handlers,
}: {
  quote: QuoteListRow;
  permissions: QuoteRowPermissions;
  busy: boolean;
  handlers: QuoteRowHandlers;
}) {
  const badge = quoteBadge(quote);
  const can = rowActions(quote, permissions);
  const note = approvalNote(quote);
  const floorMiss = missesMarginFloor(quote);
  const hasEmail = quote.customerEmail !== null && quote.customerEmail !== '';
  return (
    <tr role="row" className="block px-1 py-3 hover:bg-hover/60 md:table-row md:p-0">
      <td role="cell" className="block px-4 py-1.5 md:table-cell md:py-3">
        <button
          type="button"
          onClick={() => handlers.view(quote)}
          className="inline-flex items-center gap-1 font-semibold text-indigo-700 underline decoration-indigo-400 decoration-1 underline-offset-4 hover:text-indigo-900 hover:decoration-2 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:text-indigo-300 dark:decoration-indigo-300 dark:hover:text-indigo-100"
        >
          {quote.quoteNumber}
          <span className="text-xs font-medium">View details</span>
        </button>
        <div className="mt-0.5 text-xs text-fg-subtle">
          {new Date(quote.createdAt).toLocaleDateString()}
        </div>
      </td>
      <td role="cell" className="block px-4 py-1.5 md:table-cell md:py-3">
        <div className="font-medium text-fg-strong">{quote.customerName}</div>
        <div className="text-xs text-fg-muted">
          {hasEmail ? quote.customerEmail : (quote.customerReference ?? '—')}
        </div>
        {can.missingEmail && (
          <span className="mt-1 inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs font-semibold text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
            <MailWarning className="h-3 w-3" aria-hidden="true" />
            No email: edit the quote to add one
          </span>
        )}
      </td>
      <td role="cell" className="block px-4 py-1.5 md:table-cell md:py-3 md:text-right font-mono font-semibold text-fg-strong">
        <span className="mr-2 font-sans text-xs font-normal text-fg-muted md:hidden">Total</span>
        {money(Number(quote.totalAmount), quote.currency)}
      </td>
      <td role="cell" className="block px-4 py-1.5 md:table-cell md:py-3 md:text-right">
        <span className="mr-2 text-xs text-fg-muted md:hidden">Gross margin</span>
        <span
          className={`font-mono font-semibold ${floorMiss ? 'text-red-700' : 'text-emerald-700'}`}
        >
          {Number(quote.grossMarginPercent).toFixed(1)}%
        </span>
        <div className="text-xs text-fg-muted">
          {money(Number(quote.grossProfit), quote.currency)}
        </div>
      </td>
      <td role="cell" className="block px-4 py-1.5 md:table-cell md:py-3">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${TONES[badge.tone]}`}
        >
          {badge.waitingOnMargin && <Clock3 className="h-3.5 w-3.5" aria-hidden />}
          {badge.label}
        </span>
        {note !== null && <p className="mt-1 text-xs text-fg-muted">{note}</p>}
      </td>
      <td role="cell" className="block px-4 py-1.5 md:table-cell md:py-3 text-xs text-fg-muted">
        <span className="mr-1 md:hidden">Valid until</span>
        {quote.validUntil === null ? 'No expiry' : new Date(quote.validUntil).toLocaleDateString()}
      </td>
      <td role="cell" className="block px-4 py-1.5 md:table-cell md:py-3">
        <div className="flex flex-wrap gap-1 md:justify-end">
          <button
            type="button"
            title={`View ${quote.quoteNumber}`}
            aria-label={`View ${quote.quoteNumber}`}
            onClick={() => handlers.view(quote)}
            className="inline-flex min-h-10 items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-xs font-semibold text-indigo-800 hover:bg-indigo-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200 dark:hover:bg-indigo-900/60"
          >
            <Eye className="h-3.5 w-3.5" aria-hidden /> View
          </button>
          {can.template && (
            <button
              type="button"
              title="Create a template from this quote"
              aria-label={`Create a template from ${quote.quoteNumber}`}
              onClick={() => handlers.template(quote)}
              className={`${iconButton} text-fg-muted hover:text-fg-strong`}
            >
              <Files className="h-4 w-4" aria-hidden />
            </button>
          )}
          <button
            type="button"
            title="Download PDF"
            aria-label={`Download PDF of ${quote.quoteNumber}`}
            onClick={() => handlers.download(quote)}
            className={`${iconButton} text-fg-muted hover:text-fg-strong`}
          >
            <Download className="h-4 w-4" aria-hidden />
          </button>
          {can.edit && (
            <button
              type="button"
              title="Edit quote"
              aria-label={`Edit ${quote.quoteNumber}`}
              onClick={() => handlers.edit(quote)}
              className={`${iconButton} px-2 text-fg-muted hover:text-fg-strong`}
            >
              Edit
            </button>
          )}
          {can.approve && (
            <button
              type="button"
              title="Approve quote"
              aria-label={`Approve ${quote.quoteNumber}`}
              disabled={busy}
              onClick={() => handlers.approve(quote)}
              className={`${iconButton} text-emerald-700 hover:bg-emerald-50`}
            >
              <BadgeCheck className="h-4 w-4" aria-hidden />
            </button>
          )}
          {can.email && (
            <button
              type="button"
              title={
                hasEmail
                  ? 'Email quotation'
                  : 'Add a customer email to this quote before sending it'
              }
              aria-label={
                hasEmail
                  ? `Email ${quote.quoteNumber}`
                  : `Cannot email ${quote.quoteNumber}: no customer email`
              }
              disabled={busy || !hasEmail}
              onClick={() => handlers.email(quote)}
              className={`${iconButton} text-indigo-700 hover:bg-indigo-50`}
            >
              <Send className="h-4 w-4" aria-hidden />
            </button>
          )}
          {can.convert && (
            <button
              type="button"
              title="Convert to order"
              aria-label={`Convert ${quote.quoteNumber} to an order`}
              disabled={busy}
              onClick={() => handlers.convert(quote)}
              className={`${iconButton} text-emerald-700 hover:bg-emerald-50`}
            >
              <ShoppingCart className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
