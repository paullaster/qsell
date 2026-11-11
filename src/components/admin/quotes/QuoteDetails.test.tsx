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

function show(
  over: {
    error?: string | null;
    busy?: boolean;
    onRevise?: () => void;
    quote?: Partial<SalesQuote>;
  } = {},
) {
  return render(
    <QuoteDetails
      quote={{ ...quote, ...over.quote }}
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

describe('QuoteDetails staff', () => {
  it('says who made the quote and that it has not been emailed yet', () => {
    show({ quote: { createdByName: 'Wanjiru Kamau', sentAt: null, sentByName: null } });
    expect(screen.getByText('Wanjiru Kamau')).toBeInTheDocument();
    expect(screen.getByText('Not emailed yet')).toBeInTheDocument();
  });

  it('says who emailed it to the customer and when', () => {
    show({
      quote: {
        createdByName: 'Wanjiru Kamau',
        sentAt: new Date('2026-10-02T09:00:00Z'),
        sentByName: 'Otieno Ouma',
      },
    });
    expect(screen.getByText('Emailed to customer by')).toBeInTheDocument();
    expect(screen.getByText('Otieno Ouma')).toBeInTheDocument();
  });

  it('shows the customer details unless they are hidden', () => {
    const view = show({ quote: { showBillingAddress: true } });
    expect(screen.getByText('Bill to')).toBeInTheDocument();
    view.unmount();
    show({ quote: { showBillingAddress: false } });
    expect(screen.queryByText('Bill to')).toBeNull();
  });
});
