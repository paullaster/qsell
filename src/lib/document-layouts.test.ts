import { describe, expect, it } from 'vitest';
import { documentLayoutsProblem, resolveDocumentLayouts } from './document-layouts';

describe('company printable document layouts', () => {
  it('fills defaults for document types and invalid stored layout parts', () => {
    expect(resolveDocumentLayouts({ quote: { footerText: 'Valid for 30 days' } })).toMatchObject({
      quote: {
        headerText: '',
        headerPosition: 'above_company',
        footerText: 'Valid for 30 days',
        footerPosition: 'after_terms',
      },
      invoice: { headerText: '', footerText: '' },
      receipt: { headerText: '', footerText: '' },
    });
  });

  it('keeps the previous invoice footer as a migration fallback', () => {
    expect(resolveDocumentLayouts({}, 'Old invoice note').invoice.footerText).toBe(
      'Old invoice note',
    );
    expect(
      resolveDocumentLayouts({ invoice: { footerText: 'New note' } }, 'Old note').invoice
        .footerText,
    ).toBe('New note');
  });

  it('validates all document text and placement controls on the server', () => {
    const valid = resolveDocumentLayouts({});
    expect(documentLayoutsProblem(valid)).toBeNull();
    expect(
      documentLayoutsProblem({ ...valid, quote: { ...valid.quote, headerPosition: 'middle' } }),
    ).toMatch(/header position/);
    expect(
      documentLayoutsProblem({
        ...valid,
        invoice: { ...valid.invoice, footerText: 'x'.repeat(2001) },
      }),
    ).toMatch(/footer note/);
    expect(documentLayoutsProblem({ quote: null })).toMatch(/Settings for quote are missing/);
  });
});
