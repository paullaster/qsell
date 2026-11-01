'use client';

import { use, useState } from 'react';
import { FileText, Save } from 'lucide-react';
import {
  saveCompanyDocumentLayoutsAction,
  type companyDocumentLayoutsAction,
} from '@/server/domains/company/actions';
import {
  PRINTABLE_DOCUMENTS,
  type DocumentLayouts,
  type PrintableDocument,
} from '@/lib/document-layouts';
import {
  attempt,
  LoadFailed,
  Message,
  primaryClass,
  fieldClass,
  Field,
  type Notice,
} from '@/components/ui/screen-kit';

const titles: Record<PrintableDocument, string> = {
  quote: 'Quotes',
  invoice: 'Invoices and proforma invoices',
  receipt: 'Receipts',
};

export function CompanyDocumentLayoutsClient({
  layoutsPromise,
}: {
  layoutsPromise: ReturnType<typeof companyDocumentLayoutsAction>;
}) {
  const loaded = use(layoutsPromise);
  if (!loaded.ok) return <LoadFailed error={loaded.error} />;
  return <DocumentLayoutsScreen initial={loaded.data} />;
}

function DocumentLayoutsScreen({ initial }: { initial: DocumentLayouts }) {
  const [layouts, setLayouts] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const update = (
    document: PrintableDocument,
    field: 'headerText' | 'headerPosition' | 'footerText' | 'footerPosition',
    value: string,
  ) => {
    setLayouts((current) => ({
      ...current,
      [document]: { ...current[document], [field]: value },
    }));
  };

  const save = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    const result = await attempt(saveCompanyDocumentLayoutsAction(layouts));
    setBusy(false);
    if (!result.ok) {
      setNotice({ kind: 'error', text: result.error });
      return;
    }
    setLayouts(result.data);
    setNotice({ kind: 'ok', text: 'Document layouts saved.' });
  };

  return (
    <form
      aria-label="Document layouts"
      className="space-y-5"
      onSubmit={(event) => void save(event)}
    >
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-fg-strong">
            <FileText className="h-5 w-5 text-indigo-600" aria-hidden="true" />
            Document layouts
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-fg-muted">
            Set optional header text, footer notes, and where they appear on each printable
            document. Leave a field empty to keep the document&apos;s standard wording.
          </p>
        </div>
        <button type="submit" className={`${primaryClass} gap-2`} disabled={busy}>
          <Save className="h-4 w-4" aria-hidden="true" />
          {busy ? 'Saving…' : 'Save layouts'}
        </button>
      </header>
      <Message notice={notice} />

      {PRINTABLE_DOCUMENTS.map((document) => (
        <section
          aria-labelledby={`document-${document}-heading`}
          className="space-y-4 rounded-xl border border-line bg-surface-raised p-4 sm:p-5"
          key={document}
        >
          <div>
            <h3 className="font-semibold text-fg-strong" id={`document-${document}-heading`}>
              {titles[document]}
            </h3>
            <p className="mt-1 text-xs text-fg-muted">
              This layout applies to new documents of this type when they are printed or downloaded.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              id={`${document}-header`}
              label="Header note"
              hint="Optional text shown in the document header."
            >
              <textarea
                id={`${document}-header`}
                className={`${fieldClass} min-h-20`}
                rows={3}
                maxLength={1000}
                value={layouts[document].headerText}
                onChange={(event) => update(document, 'headerText', event.target.value)}
              />
            </Field>
            <fieldset className="space-y-2">
              <legend className="text-xs font-semibold text-fg">Header note position</legend>
              <div
                className="grid gap-2 sm:grid-cols-2"
                role="group"
                aria-label={`${titles[document]} header position`}
              >
                <button
                  type="button"
                  aria-pressed={layouts[document].headerPosition === 'above_company'}
                  className={`min-h-11 rounded-lg border px-3 text-sm ${layouts[document].headerPosition === 'above_company' ? 'border-indigo-600 bg-indigo-50 font-semibold text-indigo-900' : 'border-line text-fg-muted'}`}
                  onClick={() => update(document, 'headerPosition', 'above_company')}
                >
                  Before company details
                </button>
                <button
                  type="button"
                  aria-pressed={layouts[document].headerPosition === 'below_company'}
                  className={`min-h-11 rounded-lg border px-3 text-sm ${layouts[document].headerPosition === 'below_company' ? 'border-indigo-600 bg-indigo-50 font-semibold text-indigo-900' : 'border-line text-fg-muted'}`}
                  onClick={() => update(document, 'headerPosition', 'below_company')}
                >
                  After company details
                </button>
              </div>
            </fieldset>
            <Field
              id={`${document}-footer`}
              label="Footer note"
              hint="Optional business-specific text printed with the document."
            >
              <textarea
                id={`${document}-footer`}
                className={`${fieldClass} min-h-24`}
                rows={4}
                maxLength={2000}
                value={layouts[document].footerText}
                onChange={(event) => update(document, 'footerText', event.target.value)}
              />
            </Field>
            <fieldset className="space-y-2">
              <legend className="text-xs font-semibold text-fg">Footer note position</legend>
              <div
                className="grid gap-2 sm:grid-cols-2"
                role="group"
                aria-label={`${titles[document]} footer position`}
              >
                <button
                  type="button"
                  aria-pressed={layouts[document].footerPosition === 'after_totals'}
                  className={`min-h-11 rounded-lg border px-3 text-sm ${layouts[document].footerPosition === 'after_totals' ? 'border-indigo-600 bg-indigo-50 font-semibold text-indigo-900' : 'border-line text-fg-muted'}`}
                  onClick={() => update(document, 'footerPosition', 'after_totals')}
                >
                  After totals
                </button>
                <button
                  type="button"
                  aria-pressed={layouts[document].footerPosition === 'after_terms'}
                  className={`min-h-11 rounded-lg border px-3 text-sm ${layouts[document].footerPosition === 'after_terms' ? 'border-indigo-600 bg-indigo-50 font-semibold text-indigo-900' : 'border-line text-fg-muted'}`}
                  onClick={() => update(document, 'footerPosition', 'after_terms')}
                >
                  After payment terms and conditions
                </button>
              </div>
            </fieldset>
          </div>
        </section>
      ))}
      <div className="flex justify-end">
        <button type="submit" className={`${primaryClass} gap-2`} disabled={busy}>
          <Save className="h-4 w-4" aria-hidden="true" />
          {busy ? 'Saving…' : 'Save layouts'}
        </button>
      </div>
    </form>
  );
}
