import { Suspense } from 'react';
import { TemplatesRoute } from '@/components/admin/quote-templates/TemplatesRoute';
import {
  getSalesQuoteCapabilitiesAction,
  getSalesQuoteEditorDataAction,
} from '@/server/domains/quotes/actions';

/** The same form, intercepted: shown over the page the person was on. */
export default function Page() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-fg-muted">Loading…</p>}>
      <TemplatesRoute
        kind="quote"
        creating={true}
        variant="modal"
        dataPromise={getSalesQuoteEditorDataAction()}
        capabilitiesPromise={getSalesQuoteCapabilitiesAction()}
      />
    </Suspense>
  );
}
