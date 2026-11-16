// @vitest-environment jsdom

import { useEffect } from 'react';
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
const { checkPackageBasketAction } = vi.hoisted(() => ({ checkPackageBasketAction: vi.fn() }));
vi.mock('@/server/domains/pricing/package-shop-actions', () => ({ checkPackageBasketAction }));
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

describe('CartProvider with packages', () => {
  const okAnswer = (servings: number) => ({ ok: true, key: 'k', servings, servingPrice: 500, total: 500 * servings, summary: 'Express lunch: Small fish', note: '' });
  const line = (optionId: string, servings = 1) => ({ id: `lunch#fish:${optionId}:1`, productId: 'lunch', picks: [{ slotId: 'fish', optionId, count: 1 }], note: '', servings });
  const holder: { cart: ReturnType<typeof useCart> | null } = { cart: null };
  function PackageProbe() {
    const cart = useCart();
    useEffect(() => {
      holder.cart = cart;
    });
    const names = cart.packages.map((l) => `${l.id}x${String(l.servings)}`).join(',');
    const text = names === '' ? 'none' : names;
    return <p data-testid="packages">{cart.ready ? text : 'loading'}|{String(cart.count)}</p>;
  }
  const packagesShown = () => screen.getByTestId('packages').textContent;

  beforeEach(() => {
    state.sessionName = null;
    checkPackageBasketAction.mockReset().mockImplementation((lines: { servings: number }[]) => Promise.resolve({ ok: true, data: lines.map((l) => okAnswer(l.servings)) }));
  });

  it('adds a package line once the shop accepts it, counts servings on the badge and keeps only ids and counts in the browser', async () => {
    render(<CartProvider><PackageProbe /></CartProvider>);
    await waitFor(() => expect(packagesShown()).toBe('none|0'));
    await act(async () => { await holder.cart?.addPackage(line('small', 2)); });
    expect(packagesShown()).toBe('lunch#fish:small:1x2|2');
    const stored = window.localStorage.getItem('qsell_cart_packages_v1') ?? '';
    expect(stored).toContain('"servings":2');
    expect(stored).not.toContain('price');
  });

  it('does not add a line the shop refuses, and returns the reason', async () => {
    checkPackageBasketAction.mockResolvedValue({ ok: true, data: [{ ok: false, problems: ['Brown ugali is sold out.'] }] });
    render(<CartProvider><PackageProbe /></CartProvider>);
    await waitFor(() => expect(packagesShown()).toBe('none|0'));
    let answer: unknown = null;
    await act(async () => { answer = await holder.cart?.addPackage(line('small')); });
    expect(answer).toEqual({ ok: false, problems: ['Brown ugali is sold out.'] });
    expect(packagesShown()).toBe('none|0');
  });

  it('edits a line in place and joins equal choices', async () => {
    render(<CartProvider><PackageProbe /></CartProvider>);
    await waitFor(() => expect(packagesShown()).toBe('none|0'));
    await act(async () => { await holder.cart?.addPackage(line('small')); await holder.cart?.addPackage(line('large', 2)); });
    await act(async () => { await holder.cart?.editPackage('lunch#fish:small:1', line('large')); });
    expect(packagesShown()).toBe('lunch#fish:large:1x3|3');
  });

  it('changes servings, removes a line and empties with the cart', async () => {
    render(<CartProvider><PackageProbe /></CartProvider>);
    await waitFor(() => expect(packagesShown()).toBe('none|0'));
    await act(async () => { await holder.cart?.addPackage(line('small')); });
    act(() => holder.cart?.setPackageServings('lunch#fish:small:1', 4));
    expect(packagesShown()).toBe('lunch#fish:small:1x4|4');
    act(() => holder.cart?.removePackage('lunch#fish:small:1'));
    expect(packagesShown()).toBe('none|0');
    await act(async () => { await holder.cart?.addPackage(line('small')); });
    act(() => holder.cart?.clear());
    expect(packagesShown()).toBe('none|0');
  });

  it('is read back from the browser, and checked again, when the page opens', async () => {
    window.localStorage.setItem('qsell_cart_packages_v1', JSON.stringify([{ productId: 'lunch', servings: 3, picks: [{ slotId: 'fish', optionId: 'small', count: 1 }] }]));
    render(<CartProvider><PackageProbe /></CartProvider>);
    await waitFor(() => expect(packagesShown()).toBe('lunch#fish:small:1x3|3'));
    await waitFor(() => expect(checkPackageBasketAction).toHaveBeenCalled());
    expect(holder.cart?.packageChecks['lunch#fish:small:1']).toMatchObject({ ok: true, total: 1500 });
  });
});
