// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SalesQuote } from '@/server/domains/quotes/service';
import { QuoteDetails } from './QuoteDetails';

const quote = {
  id: 'q1',
  quoteNumber: 'QT-0001',
  status: 'draft',
  customerName: 'Buyer',
  customerEmail: null,
  currency: 'KES',
  totalAmount: '100',
  grossMarginPercent: '30',
  minimumMarginPercent: '10',
  validUntil: null,
  billingAddress: { street: '1', city: 'N', countyOrState: 'N', country: 'KE' },
  deliveryAddress: { street: '1', city: 'N', countyOrState: 'N', country: 'KE' },
  lines: [],
  events: [],
  approvalStatus: 'none',
  approvalManagedBy: null,
  grossProfit: '30',
  internalNotes: null,
  publicNotes: null,
  paymentDetails: null,
  paymentMethod: 'mpesa_daraja',
  paymentTerms: null,
  showBillingAddress: false,
  termsAndConditions: null,
  sections: [],
} as unknown as SalesQuote;

function show(over: { error?: string | null; busy?: boolean; onRevise?: () => void } = {}) {
  return render(
    <QuoteDetails
      quote={quote}
      canApprove
      canDelete
      canRevise
      onTemplate={vi.fn()}
      busy={over.busy ?? false}
      error={over.error ?? null}
      onClose={vi.fn()}
      onApprove={vi.fn()}
      onResubmit={vi.fn()}
      onAccept={vi.fn()}
      onReject={vi.fn()}
      onCancel={vi.fn()}
      onRevise={over.onRevise ?? vi.fn()}
      onConvert={vi.fn()}
      onPreview={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe('QuoteDetails feedback', () => {
  it('says what went wrong inside the dialog, as an alert', () => {
    show({ error: 'Widget cannot be sold.' });
    expect(screen.getByRole('alert').textContent).toBe('Widget cannot be sold.');
  });

  it('shows no alert when nothing went wrong', () => {
    show();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('asks for a revision on click, and shows it is working while it runs', () => {
    const onRevise = vi.fn();
    const view = show({ onRevise });
    fireEvent.click(screen.getByRole('button', { name: 'Create revision' }));
    expect(onRevise).toHaveBeenCalledTimes(1);
    view.unmount();
    show({ busy: true });
    const working = screen.getByRole('button', { name: 'Creating revision…' });
    expect((working as HTMLButtonElement).disabled).toBe(true);
  });
});
