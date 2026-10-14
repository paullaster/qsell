import { AdminSalesQuotes } from '@/components/admin/AdminSalesQuotes';
import {
  getSalesQuoteCapabilitiesAction,
  listSalesQuotesPageAction,
} from '@/server/domains/quotes/actions';
import { parseQuoteListRequest } from '@/server/domains/quotes/quote-list';

/** The first value of a query-string parameter, whatever the address held. */
const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * The quotes page. The search and status come from the address; the first page of the list is
 * started here and handed on as a promise, so the page does not wait for it and the header and
 * tabs show at once. An address that is not valid falls back to the plain list.
 */
export default async function AdminQuotesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const parsed = parseQuoteListRequest({ query: first(params.q), status: first(params.status) });
  const { query, status } = parsed.ok ? parsed.value : { query: '', status: 'all' as const };
  return (
    <AdminSalesQuotes
      quotesPage={listSalesQuotesPageAction({ query, status })}
      query={query}
      status={status}
      capabilitiesPromise={getSalesQuoteCapabilitiesAction()}
    />
  );
}
