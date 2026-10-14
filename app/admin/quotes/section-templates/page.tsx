import { Suspense } from 'react';
import { TemplatesRoute } from '@/components/admin/quote-templates/TemplatesRoute';
import {
  getSalesQuoteCapabilitiesAction,
  getSalesQuoteEditorDataAction,
} from '@/server/domains/quotes/actions';

/** All section templates, on their own page (a direct visit or refresh). */
export default function Page() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-fg-muted">Loading…</p>}>
      <TemplatesRoute
        kind="section"
        creating={false}
        variant="page"
        dataPromise={getSalesQuoteEditorDataAction()}
        capabilitiesPromise={getSalesQuoteCapabilitiesAction()}
      />
    </Suspense>
  );
}
