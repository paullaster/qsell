import { Suspense } from 'react';
import { TemplatesRoute } from '@/components/admin/quote-templates/TemplatesRoute';
import {
  getSalesQuoteCapabilitiesAction,
  getSalesQuoteEditorDataAction,
  listSectionTemplatesPageAction,
} from '@/server/domains/quotes/actions';

/** Create a section template, on its own page (a direct visit or refresh). */
export default function Page() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-fg-muted">Loading…</p>}>
      <TemplatesRoute
        kind="section"
        creating={true}
        variant="page"
        dataPromise={getSalesQuoteEditorDataAction()}
        capabilitiesPromise={getSalesQuoteCapabilitiesAction()}
        sectionPage={listSectionTemplatesPageAction({})}
      />
    </Suspense>
  );
}
