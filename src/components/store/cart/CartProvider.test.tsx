// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CART_STORAGE_KEY } from '@/lib/cart-storage';

const state = vi.hoisted((): { sessionName: string | null } => ({ sessionName: 'Wanjiru' }));
const { mergeServerCartAction, saveServerCartAction, serverCartAction, productsByIdsAction, packagingProductsByIdsAction } = vi.hoisted(() => ({
  mergeServerCartAction: vi.fn(),
  saveServerCartAction: vi.fn(),
  serverCartAction: vi.fn(),
  productsByIdsAction: vi.fn(),
  packagingProductsByIdsAction: vi.fn(),
}));

vi.mock('@/server/domains/cart/actions', () => ({ mergeServerCartAction, saveServerCartAction, serverCartAction }));
vi.mock('@/server/domains/catalog/storefront-actions', () => ({ productsByIdsAction, packagingProductsByIdsAction }));
vi.mock('@/components/store/StoreContext', () => ({ useStore: () => ({ sessionName: state.sessionName, money: (n: number) => `KES ${String(n)}` }) }));
vi.mock('@/components/store/ToastProvider', () => ({ useToast: () => vi.fn() }));

const { CartProvider, useCart } = await import('./CartProvider');

const rice = { id: 'p1', name: 'Rice', price: 100, stockQuantity: 50, reservedQuantity: 0, baseUnitDecimals: 0, baseUnitCode: 'pc' };
const tea = { ...rice, id: 'p2', name: 'Tea' };

const summary = (cart: ReturnType<typeof useCart>): string => {
  if (!cart.ready) return 'loading';
  return cart.lines.length === 0 ? 'empty' : cart.lines.map((l) => `${l.product.id}x${String(l.quantity)}`).join(',');
};

function Probe() {
  const cart = useCart();
  return (
    <div>
      <p data-testid="state">{summary(cart)}</p>
      <button type="button" onClick={() => cart.add(tea as never, 1)}>add tea</button>
    </div>
  );
}
const shown = () => screen.getByTestId('state').textContent;

afterEach(cleanup);
beforeEach(() => {
  window.localStorage.clear();
  state.sessionName = 'Wanjiru';
  mergeServerCartAction.mockReset().mockResolvedValue({ ok: true, data: [] });
  saveServerCartAction.mockReset().mockResolvedValue({ ok: true, data: [] });
  serverCartAction.mockReset().mockResolvedValue({ ok: true, data: [] });
  productsByIdsAction.mockReset().mockImplementation((ids: { id: string }[]) => Promise.resolve([rice, tea].filter((p) => ids.some((i) => i.id === p.id))));
  packagingProductsByIdsAction.mockReset().mockResolvedValue([]);
});

describe('CartProvider with an account', () => {
  it('joins the cart in the browser with the account’s and shows the joined cart', async () => {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([{ productId: 'p1', quantity: 2, price: 100 }]));
    mergeServerCartAction.mockResolvedValue({ ok: true, data: [{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 1 }] });
    render(<CartProvider><Probe /></CartProvider>);
    await waitFor(() => expect(shown()).toBe('p1x2,p2x1'));
    expect(mergeServerCartAction).toHaveBeenCalledWith([{ productId: 'p1', quantity: 2 }]);
  });

  it('shows the browser’s cart at once and never overwrites it with an add made while the account is still being asked', async () => {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([{ productId: 'p1', quantity: 2, price: 100 }]));
    let answer: (value: unknown) => void = () => undefined;
    mergeServerCartAction.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    render(<CartProvider><Probe /></CartProvider>);
    await waitFor(() => expect(shown()).toBe('p1x2'));
    act(() => screen.getByRole('button', { name: 'add tea' }).click());
    const stored = () => (JSON.parse(window.localStorage.getItem(CART_STORAGE_KEY) ?? '[]') as { productId: string }[]).map((l) => l.productId).sort();
    expect(stored()).toEqual(['p1', 'p2']);
    answer({ ok: true, data: [{ productId: 'p1', quantity: 2 }] });
    await waitFor(() => expect(saveServerCartAction).toHaveBeenCalled());
    expect(stored()).toEqual(['p1', 'p2']);
    expect(saveServerCartAction.mock.calls.at(-1)?.[0]).toEqual([{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 1 }]);
  });

  it('keeps the account’s cart up to date after a change, and not before the cart was joined', async () => {
    render(<CartProvider><Probe /></CartProvider>);
    await waitFor(() => expect(shown()).toBe('empty'));
    expect(saveServerCartAction).not.toHaveBeenCalled();
    act(() => screen.getByRole('button', { name: 'add tea' }).click());
    await waitFor(() => expect(saveServerCartAction).toHaveBeenCalledWith([{ productId: 'p2', quantity: 1 }]));
  });

  it('falls back to the browser’s cart, and sends nothing, when the account cannot be reached', async () => {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([{ productId: 'p1', quantity: 3, price: 100 }]));
    mergeServerCartAction.mockRejectedValue(new Error('offline'));
    render(<CartProvider><Probe /></CartProvider>);
    await waitFor(() => expect(shown()).toBe('p1x3'));
    act(() => screen.getByRole('button', { name: 'add tea' }).click());
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(saveServerCartAction).not.toHaveBeenCalled();
  });

  it('never sends an empty browser over the account when the join failed', async () => {
    mergeServerCartAction.mockResolvedValue({ ok: false, error: 'Please sign in first.' });
    render(<CartProvider><Probe /></CartProvider>);
    await waitFor(() => expect(shown()).toBe('empty'));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(saveServerCartAction).not.toHaveBeenCalled();
  });
});

describe('CartProvider as a guest', () => {
  it('keeps the cart in the browser and never calls the account', async () => {
    state.sessionName = null;
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([{ productId: 'p1', quantity: 1, price: 100 }]));
    render(<CartProvider><Probe /></CartProvider>);
    await waitFor(() => expect(shown()).toBe('p1x1'));
    act(() => screen.getByRole('button', { name: 'add tea' }).click());
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(mergeServerCartAction).not.toHaveBeenCalled();
    expect(saveServerCartAction).not.toHaveBeenCalled();
  });
});
