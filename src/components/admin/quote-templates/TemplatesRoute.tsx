'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, X } from 'lucide-react';
import type { getSalesQuoteEditorDataAction } from '@/server/domains/quotes/actions';
import { AdminSalesQuoteTemplates } from '../AdminSalesQuoteTemplates';
import { AdminSectionTemplates } from '../AdminSectionTemplates';
import { useModalKeys } from '../quote-layout/useModalKeys';
import type { PageResult } from '@/components/ui/usePagedList';
import type { TemplateListRow } from '@/server/domains/quotes/service';
import type { SectionTemplateListRow } from '@/server/domains/quotes/section-template-service';

type EditorData = Awaited<ReturnType<typeof getSalesQuoteEditorDataAction>>;

interface Capabilities {
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

/**
 * The full list of quote templates or section templates, and the form to create one, as a route.
 * It is the page you get on a direct visit or refresh. When it is opened from a quote that is
 * being edited, the same route is intercepted and shown over that quote (`variant="modal"`), so
 * the quote and everything typed into it stay where they were; closing goes back to it.
 */
export function TemplatesRoute({
  kind,
  creating,
  variant,
  dataPromise,
  capabilitiesPromise,
  quotePage,
  sectionPage,
}: {
  kind: 'quote' | 'section';
  /** True on the create route: the editor opens at once on a new template. */
  creating: boolean;
  variant: 'page' | 'modal';
  dataPromise: Promise<EditorData>;
  capabilitiesPromise: Promise<Capabilities>;
  /** The first page of the list, started by the server page (for `kind` quote). */
  quotePage?: Promise<PageResult<TemplateListRow>>;
  /** The first page of the list, started by the server page (for `kind` section). */
  sectionPage?: Promise<PageResult<SectionTemplateListRow>>;
}) {
  const data = use(dataPromise);
  const firstQuotePage = quotePage === undefined ? undefined : use(quotePage);
  const firstSectionPage = sectionPage === undefined ? undefined : use(sectionPage);
  const capabilities = use(capabilitiesPromise);
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listHref = kind === 'quote' ? '/admin/quotes/templates' : '/admin/quotes/section-templates';
  const noun = kind === 'quote' ? 'Quote templates' : 'Section templates';

  const leave = (saved: boolean) => {
    if (variant === 'modal') router.back();
    // A direct visit has nothing to go back to: a saved template lands on the list, otherwise
    // the quotes page.
    else router.push(saved || !creating ? listHref : '/admin/quotes');
  };

  const shared = {
    products: data.products,
    canCreate: capabilities.canCreate,
    canUpdate: capabilities.canUpdate,
    canDelete: capabilities.canDelete,
    onMessage: setNotice,
    onError: (message: string) => setError(message === '' ? null : message),
    startWithEditor: creating,
    onEditorClose: creating ? leave : undefined,
  };

  const content = (
    <div className="space-y-3">
      {error !== null && (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error}
        </p>
      )}
      {notice !== null && (
        <p
          role="status"
          className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {notice}
        </p>
      )}
      {kind === 'quote' ? (
        <AdminSalesQuoteTemplates {...shared} initialPage={firstQuotePage} />
      ) : (
        <AdminSectionTemplates {...shared} initialPage={firstSectionPage} />
      )}
    </div>
  );

  if (variant === 'page') {
    return (
      <div className="space-y-4">
        <Link
          href="/admin/quotes"
          className="inline-flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm font-medium text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back to quotes
        </Link>
        <h1 className="text-xl font-bold text-fg-strong">{noun}</h1>
        {content}
      </div>
    );
  }
  return (
    <ModalShell title={noun} onClose={() => router.back()}>
      {content}
    </ModalShell>
  );
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useModalKeys<HTMLElement>(onClose);
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-backdrop/70 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[94dvh] w-full max-w-6xl overflow-y-auto rounded-2xl border border-line bg-surface-raised p-4 shadow-2xl sm:p-6"
      >
        <header className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-fg-strong">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-fg-muted hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
