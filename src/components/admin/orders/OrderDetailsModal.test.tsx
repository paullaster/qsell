// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Order } from '@/types/index';

// The panels read their own data from the server; here they are plain markers, because what is checked is how the modal lays them out.
vi.mock('@/server/domains/invoices/actions', () => ({ deliveryInvoiceAvailableAction: () => Promise.resolve({ ok: true, data: { available: false } }) }));
vi.mock('@/components/admin/approvals/OrderApprovalBanner', () => ({ OrderApprovalBanner: () => null }));
vi.mock('@/components/admin/OrderCreditNotesPanel', () => ({ OrderCreditNotesPanel: () => <div data-testid="credit-notes" /> }));
vi.mock('./OrderReferencePanel', () => ({ OrderReferencePanel: () => null }));
vi.mock('./OrderTimelinePanel', () => ({ OrderTimelinePanel: () => <div data-testid="timeline" /> }));
vi.mock('./OrderStockPanel', () => ({ OrderStockPanel: () => <div data-testid="stock" /> }));
vi.mock('./OrderCollectionPanel', () => ({ OrderCollectionPanel: () => <div data-testid="collection" /> }));
vi.mock('./OrderDeliveriesPanel', () => ({ OrderDeliveriesPanel: () => <div data-testid="deliveries" /> }));
vi.mock('@/components/admin/pricing/OrderTenderPanel', () => ({ OrderTenderPanel: () => <div data-testid="tender" /> }));
vi.mock('@/components/ui/autocomplete/ChoicePicker', () => ({ ChoicePicker: () => null }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));

import { OrderDetailsModal } from './OrderDetailsModal';

const order = {
  id: 'ord_a19461a1-e909-4520-9d18-236f7ff6262e',
  orderNumber: 'ORD-2026-1',
  customerName: 'Wanjiru',
  customerEmail: 'w@example.test',
  customerPhone: '0711000666',
  shippingAddress: { street: '1 Moi Avenue', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya' },
  items: [],
  subtotal: 0,
  tax: 0,
  shippingFee: 0,
  totalAmount: 0,
  currency: 'KES',
  status: 'pending',
  paymentStatus: 'pending',
  paymentMethod: 'mpesa',
  createdAt: '2026-11-05T08:00:00.000Z',
} as unknown as Order;

describe('the order details window', () => {
  afterEach(() => vi.restoreAllMocks());

  it('gives every panel its own key, so React never sees two children with the same one', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<OrderDetailsModal order={order} busy={false} invoiceBusy={false} error={null} notice={null} onClose={vi.fn()} onPreview={vi.fn()} onInvoice={vi.fn()} onSave={vi.fn()} onCancel={vi.fn()} onChanged={vi.fn()} />);
    for (const id of ['tender', 'stock', 'collection', 'deliveries', 'timeline', 'credit-notes']) expect(screen.getByTestId(id)).toBeTruthy();
    const keyWarnings = errors.mock.calls.filter((call) => String(call[0]).includes('same key'));
    expect(keyWarnings).toEqual([]);
  });
});
