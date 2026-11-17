// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RelatedDocuments } from '@/server/domains/selling/order-documents-service';

const answer: { value: { ok: true; data: RelatedDocuments | null } | { ok: false; error: string } } = { value: { ok: true, data: null } };
vi.mock('@/server/domains/selling/order-documents-actions', () => ({ orderDocumentsAction: () => Promise.resolve(answer.value) }));

import { OrderDocumentsPanel } from './OrderDocumentsPanel';

afterEach(() => {
  answer.value = { ok: true, data: null };
});

describe('the related documents of an order', () => {
  it('shows the quote it was made from, the order and its invoices in order', async () => {
    answer.value = {
      ok: true,
      data: {
        orderNumber: 'ORD-2026-7',
        quote: { id: 'q1', number: 'QTE-2026-3', status: 'converted', total: 5000, currency: 'KES' },
        invoices: [{ number: 'INV-1-26-000001', type: 'tax_invoice', total: 5000, currency: 'KES', createdAt: '2026-11-01T10:00:00.000Z', emailed: true }],
      },
    };
    render(<OrderDocumentsPanel orderId="ord_1" />);
    const quote = await screen.findByTestId('order-document-quote');
    expect(quote.textContent).toContain('QTE-2026-3');
    expect(quote.textContent).toContain('this order was made from it');
    expect(screen.getByText('Order ORD-2026-7')).toBeTruthy();
    const invoice = screen.getByTestId('order-document-invoice');
    expect(invoice.textContent).toContain('Tax invoice');
    expect(invoice.textContent).toContain('INV-1-26-000001');
    expect(invoice.textContent).toContain('emailed');
  });

  it('shows nothing for an order with no quote and no invoice, for an order that is not found, and when the documents cannot be read', async () => {
    answer.value = { ok: true, data: { orderNumber: 'ORD-2026-8', quote: null, invoices: [] } };
    const first = render(<OrderDocumentsPanel orderId="ord_2" />);
    await waitFor(() => expect(first.container.textContent).toBe(''));
    first.unmount();
    answer.value = { ok: true, data: null };
    const second = render(<OrderDocumentsPanel orderId="ord_3" />);
    await waitFor(() => expect(second.container.textContent).toBe(''));
    second.unmount();
    answer.value = { ok: false, error: 'The related documents could not be loaded.' };
    const third = render(<OrderDocumentsPanel orderId="ord_4" />);
    await waitFor(() => expect(third.container.textContent).toBe(''));
  });
});
