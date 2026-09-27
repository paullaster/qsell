import { AdminSalesQuotes } from '@/components/admin/AdminSalesQuotes';
import {
  getSalesQuoteCapabilitiesAction,
  getSalesQuoteEditorDataAction,
  listSalesQuotesAction,
} from '@/server/domains/quotes/actions';

export default function AdminQuotesPage() {
  return (
    <AdminSalesQuotes
      quotesPromise={listSalesQuotesAction()}
      editorDataPromise={getSalesQuoteEditorDataAction()}
      capabilitiesPromise={getSalesQuoteCapabilitiesAction()}
    />
  );
}
