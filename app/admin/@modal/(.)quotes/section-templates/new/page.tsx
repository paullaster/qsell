import { Suspense } from 'react';
import { TemplatesRoute } from '@/components/admin/quote-templates/TemplatesRoute';
import {
  getSalesQuoteCapabilitiesAction,
  getSalesQuoteEditorDataAction,
  listSectionTemplatesPageAction,
} from '@/server/domains/quotes/actions';

/** The same form, intercepted: shown over the page the person was on. */
export default function Page() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-fg-muted">Loading…</p>}>
      <TemplatesRoute
        kind="section"
        creating={true}
        variant="modal"
        dataPromise={getSalesQuoteEditorDataAction()}
        capabilitiesPromise={getSalesQuoteCapabilitiesAction()}
        sectionPage={listSectionTemplatesPageAction({})}
      />
    </Suspense>
  );
}
