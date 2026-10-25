// @vitest-environment jsdom
import { Suspense } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomerAddress } from '@/types/index';
import type { CustomerOrder } from '@/lib/storefront-account';

const myOrdersPageAction = vi.fn();
const saveMyAddressAction = vi.fn();
const removeMyAddressAction = vi.fn();
const makeMyAddressDefaultAction = vi.fn();

vi.mock('@/server/domains/customers/actions', () => ({
  myOrdersPageAction: (...a: unknown[]) => myOrdersPageAction(...a) as unknown,
  saveMyAddressAction: (...a: unknown[]) => saveMyAddressAction(...a) as unknown,
  removeMyAddressAction: (...a: unknown[]) => removeMyAddressAction(...a) as unknown,
  makeMyAddressDefaultAction: (...a: unknown[]) => makeMyAddressDefaultAction(...a) as unknown,
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { OrdersClient } = await import('./OrdersClient');
const { OrderDetailClient } = await import('./OrderDetailClient');
const { AddressesClient } = await import('./AddressesClient');
const { AccountSubpage } = await import('./AccountSubpage');

const order = (n: number, over: Partial<CustomerOrder> = {}): CustomerOrder => ({
  id: `o${String(n)}`,
  orderNumber: `SO-${String(n)}`,
  status: 'shipped',
  paymentStatus: 'paid',
  currency: 'KES',
  createdAt: '2026-10-01T09:00:00.000Z',
  subtotal: 100,
  tax: 16,
  shippingFee: 0,
  totalAmount: 116,
  shippingAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya' },
  shippingCourier: 'Fargo',
  trackingNumber: 'T-9',
  shippedAt: '2026-10-02T09:00:00.000Z',
  deliveredAt: null,
  items: [
    {
      productName: 'Cable',
      sku: 'C1',
      quantity: 2,
      unitPrice: 50,
      totalPrice: 100,
      imageUrl: '',
      isGift: false,
    },
  ],
  ...over,
});
const address = (id: string, over: Partial<CustomerAddress> = {}): CustomerAddress => ({
  id,
  label: `Place ${id}`,
  recipientName: 'Ann',
  recipientPhone: '0712345678',
  street: '1 Rd',
  city: 'Nairobi',
  countyOrState: 'Nairobi',
  country: 'Kenya',
  isDefault: false,
  ...over,
});
const inSuspense = (node: React.ReactNode) =>
  act(async () => {
    render(<Suspense fallback={<p>loading</p>}>{node}</Suspense>);
    await Promise.resolve();
  });

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('the frame', () => {
  it('always offers a way back to the account and to the shop', () => {
    render(
      <AccountSubpage title="My orders">
        <p>x</p>
      </AccountSubpage>,
    );
    expect(screen.getByRole('link', { name: /Back to My account/ }).getAttribute('href')).toBe(
      '/profile',
    );
    expect(screen.getByRole('link', { name: 'Continue shopping' }).getAttribute('href')).toBe('/');
    expect(screen.getByRole('heading', { level: 1, name: 'My orders' })).toBeTruthy();
  });
});

describe('my orders', () => {
  it('lists orders in plain words with a link to each', async () => {
    await inSuspense(
      <OrdersClient
        firstPage={Promise.resolve({ ok: true, data: { rows: [order(1)], nextCursor: null } })}
      />,
    );
    const link = await screen.findByRole('link', { name: /Order SO-1/ });
    expect(link.getAttribute('href')).toBe('/profile/orders/o1');
    expect(link.textContent).toContain('On its way');
    expect(link.textContent).toContain('KES 116.00');
    expect(link.textContent).toContain('2 items');
  });
  it('says so when there are no orders', async () => {
    await inSuspense(
      <OrdersClient
        firstPage={Promise.resolve({ ok: true, data: { rows: [], nextCursor: null } })}
      />,
    );
    expect(await screen.findByText('You have not placed an order yet.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Start shopping' })).toBeTruthy();
  });
  it('asks a signed-out visitor to sign in', async () => {
    await inSuspense(
      <OrdersClient
        firstPage={Promise.resolve({ ok: false, error: 'Sign in', code: 'SIGN_IN' })}
      />,
    );
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeTruthy();
  });
  it('loads older orders on request', async () => {
    myOrdersPageAction.mockResolvedValue({
      ok: true,
      data: { rows: [order(2)], nextCursor: null },
    });
    await inSuspense(
      <OrdersClient
        firstPage={Promise.resolve({ ok: true, data: { rows: [order(1)], nextCursor: 'c1' } })}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Show older orders' }));
    expect(await screen.findByRole('link', { name: /Order SO-2/ })).toBeTruthy();
    expect(myOrdersPageAction).toHaveBeenCalledWith({ cursor: 'c1' });
  });
});

describe('one order', () => {
  it('shows progress, items, totals and the delivery address, without internal data', async () => {
    await inSuspense(<OrderDetailClient result={Promise.resolve({ ok: true, data: order(1) })} />);
    expect(await screen.findByText('Order SO-1')).toBeTruthy();
    expect(screen.getByText('Your order has left us and is being delivered.')).toBeTruthy();
    expect(screen.getByText('Fargo · T-9')).toBeTruthy();
    expect(screen.getByText('Cable')).toBeTruthy();
    expect(screen.getByText('1 Rd, Nairobi, Nairobi, Kenya')).toBeTruthy();
  });
  it('shows a failure as an alert', async () => {
    await inSuspense(
      <OrderDetailClient result={Promise.resolve({ ok: false, error: 'Could not load' })} />,
    );
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load');
  });
});

describe('my addresses', () => {
  it('lists addresses and marks the delivery one', async () => {
    await inSuspense(
      <AddressesClient
        first={Promise.resolve({
          ok: true,
          data: [address('1', { isDefault: true }), address('2')],
        })}
      />,
    );
    expect(await screen.findByText('Place 1')).toBeTruthy();
    expect(screen.getByText('Delivery address')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Use for delivery' })).toHaveLength(1);
  });
  it('does not send an invalid address; it says what is missing', async () => {
    await inSuspense(<AddressesClient first={Promise.resolve({ ok: true, data: [] })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add an address' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Name this address');
    expect(saveMyAddressAction).not.toHaveBeenCalled();
  });
  it('saves a good address and shows the new list', async () => {
    saveMyAddressAction.mockResolvedValue({
      ok: true,
      data: [address('9', { label: 'Home', isDefault: true })],
    });
    await inSuspense(<AddressesClient first={Promise.resolve({ ok: true, data: [] })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add an address' }));
    const type = (label: string, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    type('Name this address', 'Home');
    type('Recipient', 'Ann');
    type('Recipient phone', '0712345678');
    type('Street or building', '1 Rd');
    type('Town or city', 'Nairobi');
    type('County or state', 'Nairobi');
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
    await waitFor(() => expect(screen.getByText('Address saved.')).toBeTruthy());
    expect(saveMyAddressAction).toHaveBeenCalledWith({
      id: null,
      address: expect.objectContaining({ label: 'Home', isDefault: true }) as unknown,
    });
    expect(screen.getByText('Home')).toBeTruthy();
  });
  it('asks before removing, and offers no removal of the only address', async () => {
    removeMyAddressAction.mockResolvedValue({ ok: true, data: [address('2')] });
    await inSuspense(
      <AddressesClient first={Promise.resolve({ ok: true, data: [address('1'), address('2')] })} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Remove address Place 1' }));
    expect(removeMyAddressAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm: Remove address Place 1' }));
    await waitFor(() => expect(removeMyAddressAction).toHaveBeenCalledWith('1'));
    await waitFor(() => expect(screen.queryByText('Place 1')).toBeNull());
    expect(screen.queryByRole('button', { name: /Remove address/ })).toBeNull();
  });
});
