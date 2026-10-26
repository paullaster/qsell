'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PublicProduct } from '@/types/index';
import { productsByIdsAction } from '@/server/domains/catalog/storefront-actions';
import { addToCart, reconcileCart, savedLines, setCartQuantity, type AddOutcome, type CartLine } from '@/lib/cart-lines';
import { CART_STORAGE_KEY, LEGACY_CART_STORAGE_KEY, parseSavedCart, serializeCart, type SavedCartLine } from '@/lib/cart-storage';
import { cartBadgeCount } from '@/lib/cart-quantity';
import { useStore } from '@/components/store/StoreContext';
import { useToast } from '@/components/store/ToastProvider';

interface CartValue {
  lines: CartLine[];
  /** The number on the cart badge. */
  count: number;
  /** False until the saved cart has been read and checked against the shop. */
  ready: boolean;
  add: (product: PublicProduct, quantity?: number) => AddOutcome;
  setQuantity: (productId: string, quantity: number) => void;
  remove: (productId: string) => void;
  clear: () => void;
  /** Checks every line against the shop now (price and stock), and tells the shopper what moved. */
  refresh: () => Promise<void>;
}

const CartContext = createContext<CartValue | null>(null);

function readSaved(): SavedCartLine[] {
  try {
    const current = window.localStorage.getItem(CART_STORAGE_KEY);
    return parseSavedCart(current ?? window.localStorage.getItem(LEGACY_CART_STORAGE_KEY));
  } catch {
    return [];
  }
}

/**
 * The shopper's cart. Only product ids and quantities are kept in the browser; prices and stock are read from
 * the shop whenever the cart is loaded, so a stale price can never reach checkout without the shopper being told.
 */
export function CartProvider({ children }: { children: ReactNode }) {
  const { money } = useStore();
  const toast = useToast();
  const [lines, setLines] = useState<CartLine[]>([]);
  const [ready, setReady] = useState(false);
  const linesRef = useRef<CartLine[]>([]);
  const moneyRef = useRef(money);
  const toastRef = useRef(toast);
  useEffect(() => {
    moneyRef.current = money;
    toastRef.current = toast;
  }, [money, toast]);

  const commit = useCallback((next: CartLine[]) => {
    linesRef.current = next;
    setLines(next);
    try {
      window.localStorage.setItem(CART_STORAGE_KEY, serializeCart(savedLines(next)));
      window.localStorage.removeItem(LEGACY_CART_STORAGE_KEY);
    } catch {
      /* a browser that keeps nothing still has a working cart for this visit */
    }
  }, []);

  const load = useCallback(async (saved: SavedCartLine[]) => {
    if (saved.length === 0) {
      linesRef.current = [];
      setLines([]);
      setReady(true);
      return;
    }
    try {
      const fresh = await productsByIdsAction(saved.map((line) => line.productId));
      const result = reconcileCart(saved, fresh, moneyRef.current);
      commit(result.lines);
      for (const notice of result.notices) {
        toastRef.current({ type: 'warning', title: 'Your cart was updated', message: notice.message });
      }
    } catch {
      // The shop could not be reached: keep what we have rather than emptying a cart.
      toastRef.current({ type: 'warning', title: 'Could not check your cart', message: 'Prices and stock will be checked again at checkout.' });
    } finally {
      setReady(true);
    }
  }, [commit]);

  useEffect(() => {
    // The saved cart exists only in the browser, so it can only be read here, after the page is drawn.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading browser storage once on arrival
    void load(readSaved());
    const onStorage = (event: StorageEvent) => {
      if (event.key === CART_STORAGE_KEY) void load(readSaved());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [load]);

  const add = useCallback(
    (product: PublicProduct, quantity = 1): AddOutcome => {
      const result = addToCart(linesRef.current, product, quantity);
      if (result.outcome !== 'sold_out') commit(result.lines);
      return result.outcome;
    },
    [commit],
  );
  const setQuantity = useCallback((productId: string, quantity: number) => commit(setCartQuantity(linesRef.current, productId, quantity)), [commit]);
  const remove = useCallback((productId: string) => commit(linesRef.current.filter((line) => line.product.id !== productId)), [commit]);
  const clear = useCallback(() => commit([]), [commit]);
  const refresh = useCallback(() => load(savedLines(linesRef.current)), [load]);

  const value = useMemo<CartValue>(
    () => ({ lines, count: cartBadgeCount(lines), ready, add, setQuantity, remove, clear, refresh }),
    [lines, ready, add, setQuantity, remove, clear, refresh],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartValue {
  const value = useContext(CartContext);
  if (value === null) throw new Error('useCart must be used inside <CartProvider>.');
  return value;
}
