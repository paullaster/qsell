import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.fn();
const pageForOwner = vi.fn();
const getById = vi.fn();
const listAddresses = vi.fn();
const addAddress = vi.fn();
const updateAddress = vi.fn();
const deleteAddress = vi.fn();
const setDefaultAddress = vi.fn();

vi.mock('@/auth', () => ({ auth: (...args: unknown[]) => auth(...args) as unknown }));
vi.mock('@/server/domains/access-control/guard', () => ({
  requirePermission: vi.fn(),
  canPermission: vi.fn(),
}));
vi.mock('@/server/domains/customers/storefront-service', () => ({
  StorefrontCustomerService: {
    findById: vi.fn(() =>
      Promise.resolve({ id: 'acct-1', name: 'Ann', email: 'ann@shop.co', phone: '0700000001' }),
    ),
    findByEmailOrPhone: vi.fn(),
    ensure: vi.fn(),
  },
}));
vi.mock('@/server/di/container', () => ({
  getContainer: () => ({
    companySettings: { ensureSeeded: () => Promise.resolve({ id: 'co-1' }) },
    orders: { pageForOwner, getById },
    customers: {
      ensureStorefrontCustomer: () =>
        Promise.resolve({
          id: 'trade-1',
          name: 'Ann',
          email: 'ann@shop.co',
          phone: '0700000001',
          number: 'C1',
          buyerKraPin: null,
        }),
      listAddresses,
      addAddress,
      updateAddress,
      deleteAddress,
      setDefaultAddress,
    },
  }),
}));

const actions = await import('./actions');

const signedIn = () =>
  auth.mockResolvedValue({
    user: { id: 'login-1', email: 'Ann@shop.co', role: 'customer', customerStoreId: 'acct-1' },
  });
const address = {
  label: 'Home',
  recipientName: 'Ann',
  recipientPhone: '0712 345 678',
  street: '1 Rd',
  city: 'Nairobi',
  countyOrState: 'Nairobi',
  postalCode: '',
  country: 'Kenya',
  isDefault: false,
};
const row = { id: 'ad-1', ...address, postalCode: null };

beforeEach(() => {
  vi.clearAllMocks();
  listAddresses.mockResolvedValue([row]);
});

describe('my orders', () => {
  it('asks the shopper to sign in when there is no session', async () => {
    auth.mockResolvedValue(null);
    expect(await actions.myOrdersPageAction({})).toMatchObject({ ok: false, code: 'SIGN_IN' });
    expect(pageForOwner).not.toHaveBeenCalled();
  });
  it('refuses a staff session: only customers have a shop account', async () => {
    auth.mockResolvedValue({ user: { id: 'u', email: 'staff@x.co', role: 'admin' } });
    expect(await actions.myOrdersPageAction({})).toMatchObject({ ok: false, code: 'SIGN_IN' });
  });
  it('lists orders for the session’s own marks, never a client id, with nothing internal', async () => {
    signedIn();
    pageForOwner.mockResolvedValue({
      rows: [
        {
          id: 'o1',
          orderNumber: 'SO-1',
          userId: 'acct-1',
          internalNotes: 'secret',
          status: 'pending',
          paymentStatus: 'unpaid',
          currency: 'KES',
          createdAt: '2026-10-01T00:00:00Z',
          subtotal: 1,
          tax: 0,
          shippingFee: 0,
          totalAmount: 1,
          shippingAddress: {},
          items: [],
        },
      ],
      nextCursor: 'next',
    });
    const result = await actions.myOrdersPageAction({ cursor: 'c1' });
    expect(pageForOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        tradeCustomerId: 'trade-1',
        cursor: 'c1',
        ids: expect.arrayContaining(['acct-1', 'login-1']) as unknown,
      }),
    );
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result).toMatchObject({ ok: true, data: { nextCursor: 'next' } });
  });
  it('reports a failure as data', async () => {
    signedIn();
    pageForOwner.mockRejectedValue(new Error('db down'));
    expect(await actions.myOrdersPageAction({})).toEqual({
      ok: false,
      error: 'Your orders could not be loaded. Please try again.',
    });
  });
});

describe('one order', () => {
  const base = {
    id: 'o1',
    orderNumber: 'SO-1',
    status: 'pending',
    paymentStatus: 'unpaid',
    currency: 'KES',
    createdAt: '2026-10-01T00:00:00Z',
    subtotal: 1,
    tax: 0,
    shippingFee: 0,
    totalAmount: 1,
    shippingAddress: {},
    items: [],
    tradeCustomerId: null,
  };
  it('shows my own order', async () => {
    signedIn();
    getById.mockResolvedValue({ ...base, userId: 'acct-1' });
    expect(await actions.myOrderAction('o1')).toMatchObject({
      ok: true,
      data: { orderNumber: 'SO-1' },
    });
  });
  it('says not found for someone else’s order, the same as for a missing one', async () => {
    signedIn();
    getById.mockResolvedValue({ ...base, userId: 'someone-else' });
    const theirs = await actions.myOrderAction('o1');
    getById.mockResolvedValue(null);
    const missing = await actions.myOrderAction('nope');
    expect(theirs).toEqual(missing);
    expect(theirs).toMatchObject({ ok: false, code: 'ORDER_NOT_FOUND' });
  });
});

describe('my addresses', () => {
  it('requires a session', async () => {
    auth.mockResolvedValue(null);
    expect(await actions.saveMyAddressAction({ address })).toMatchObject({
      ok: false,
      code: 'SIGN_IN',
    });
    expect(addAddress).not.toHaveBeenCalled();
  });
  it('validates on the server before writing', async () => {
    signedIn();
    const result = await actions.saveMyAddressAction({ address: { ...address, street: '' } });
    expect(result.ok).toBe(false);
    expect(addAddress).not.toHaveBeenCalled();
  });
  it('adds to the signed-in shopper’s book only', async () => {
    signedIn();
    const result = await actions.saveMyAddressAction({ address });
    expect(addAddress).toHaveBeenCalledWith(
      'trade-1',
      expect.objectContaining({ label: 'Home', postalCode: null }),
    );
    expect(result).toMatchObject({ ok: true });
  });
  it('changes an address by id within the shopper’s own book', async () => {
    signedIn();
    await actions.saveMyAddressAction({ id: 'ad-1', address });
    expect(updateAddress).toHaveBeenCalledWith('trade-1', 'ad-1', expect.any(Object));
  });
  it('explains the last-address rule in plain words', async () => {
    signedIn();
    deleteAddress.mockRejectedValue(new Error('A customer must keep at least one address.'));
    expect(await actions.removeMyAddressAction('ad-1')).toEqual({
      ok: false,
      error: 'Keep at least one address. Add another one before removing this one.',
    });
  });
  it('masks unexpected errors', async () => {
    signedIn();
    setDefaultAddress.mockRejectedValue(new Error('relation x does not exist'));
    const result = await actions.makeMyAddressDefaultAction('ad-1');
    expect(JSON.stringify(result)).not.toContain('relation');
  });
});
