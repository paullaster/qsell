import { Suspense } from 'react';
import { TemplatesRoute } from '@/components/admin/quote-templates/TemplatesRoute';
import {
  getSalesQuoteCapabilitiesAction,
  getSalesQuoteEditorDataAction,
  listSalesQuoteTemplatesPageAction,
} from '@/server/domains/quotes/actions';

/** Create a quote template, on its own page (a direct visit or refresh). */
export default function Page() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-fg-muted">Loading…</p>}>
      <TemplatesRoute
        kind="quote"
        creating={true}
        variant="page"
        dataPromise={getSalesQuoteEditorDataAction()}
        capabilitiesPromise={getSalesQuoteCapabilitiesAction()}
        quotePage={listSalesQuoteTemplatesPageAction({})}
      />
    </Suspense>
  );
}
