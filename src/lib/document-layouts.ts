import { isRecord } from '@/lib/values';

export const PRINTABLE_DOCUMENTS = ['quote', 'invoice', 'receipt'] as const;
export type PrintableDocument = (typeof PRINTABLE_DOCUMENTS)[number];
export const HEADER_POSITIONS = ['above_company', 'below_company'] as const;
export type DocumentHeaderPosition = (typeof HEADER_POSITIONS)[number];
/** `page_bottom` is the foot of every page. It replaces `after_terms`, which put the note in the middle of the page under the terms. */
export const FOOTER_POSITIONS = ['page_bottom', 'after_totals'] as const;
export type DocumentFooterPosition = (typeof FOOTER_POSITIONS)[number];

export interface DocumentLayout {
  headerText: string;
  headerPosition: DocumentHeaderPosition;
  footerText: string;
  footerPosition: DocumentFooterPosition;
}

export type DocumentLayouts = Record<PrintableDocument, DocumentLayout>;

const EMPTY_LAYOUT: DocumentLayout = {
  headerText: '',
  headerPosition: 'above_company',
  footerText: '',
  footerPosition: 'page_bottom',
};

export const DEFAULT_DOCUMENT_LAYOUTS: DocumentLayouts = {
  quote: { ...EMPTY_LAYOUT },
  invoice: { ...EMPTY_LAYOUT },
  receipt: { ...EMPTY_LAYOUT },
};

/** Read the extensible database JSON into known document types with safe defaults. */
export function resolveDocumentLayouts(
  raw: unknown,
  legacyInvoiceFooterNote = '',
): DocumentLayouts {
  const root = isRecord(raw) ? raw : {};
  return Object.fromEntries(
    PRINTABLE_DOCUMENTS.map((document) => {
      const source = isRecord(root[document]) ? root[document] : {};
      const headerPosition = HEADER_POSITIONS.find(
        (position) => position === source.headerPosition,
      );
      // Layouts saved before the foot of the page was offered say `after_terms`; they meant the footer.
      const footerPosition = FOOTER_POSITIONS.find(
        (position) =>
          position === (source.footerPosition === 'after_terms' ? 'page_bottom' : source.footerPosition),
      );
      let footerText = '';
      if (typeof source.footerText === 'string') footerText = source.footerText;
      else if (document === 'invoice') footerText = legacyInvoiceFooterNote;
      return [
        document,
        {
          headerText: typeof source.headerText === 'string' ? source.headerText : '',
          headerPosition: headerPosition ?? EMPTY_LAYOUT.headerPosition,
          footerText,
          footerPosition: footerPosition ?? EMPTY_LAYOUT.footerPosition,
        },
      ];
    }),
  ) as DocumentLayouts;
}

/** Server-side validation and normalization for the company document layout editor. */
export function documentLayoutsProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'Document layouts are not in a valid format.';
  for (const document of PRINTABLE_DOCUMENTS) {
    const layout = value[document];
    if (!isRecord(layout)) return `Settings for ${document} are missing.`;
    if (typeof layout.headerText !== 'string' || layout.headerText.length > 1000) {
      return `${document} header text must be 1,000 characters or fewer.`;
    }
    if (typeof layout.footerText !== 'string' || layout.footerText.length > 2000) {
      return `${document} footer note must be 2,000 characters or fewer.`;
    }
    if (!HEADER_POSITIONS.some((position) => position === layout.headerPosition)) {
      return `Choose a valid header position for ${document}.`;
    }
    if (
      !FOOTER_POSITIONS.some((position) => position === layout.footerPosition) &&
      layout.footerPosition !== 'after_terms'
    ) {
      return `Choose a valid footer position for ${document}.`;
    }
  }
  return null;
}
