'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PublicProduct } from '@/types/index';
import { packagingProductsByIdsAction, productsByIdsAction } from '@/server/domains/catalog/storefront-actions';
import { addToCart, keepAddedDuringLoad, reconcileCart, savedLines, setCartQuantity, type AddOutcome, type CartLine } from '@/lib/cart-lines';
import { CART_STORAGE_KEY, LEGACY_CART_STORAGE_KEY, parseSavedCart, serializeCart, type SavedCartLine } from '@/lib/cart-storage';
import { cartBadgeCount } from '@/lib/cart-quantity';
import { mergeServerCartAction, saveServerCartAction, serverCartAction } from '@/server/domains/cart/actions';
import { sameCartLines } from '@/lib/shop-cart';
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
  const { money, sessionName } = useStore();
  const signedIn = sessionName !== null;
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

  // A signed-in shopper's cart is also kept on their account (so it follows them to another device). It is set once the account's
  // cart has been joined with the browser's; until then nothing is sent, so an empty browser can never wipe a saved cart.
  const accountBacked = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const saveToAccount = useCallback((next: CartLine[]) => {
    if (!accountBacked.current) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      saveServerCartAction(savedLines(next).map((line) => ({ productId: line.productId, quantity: line.quantity }))).catch(() => undefined);
    }, 400);
  }, []);

  const commit = useCallback((next: CartLine[]) => {
    linesRef.current = next;
    setLines(next);
    saveToAccount(next);
    try {
      window.localStorage.setItem(CART_STORAGE_KEY, serializeCart(savedLines(next)));
      window.localStorage.removeItem(LEGACY_CART_STORAGE_KEY);
    } catch {
      /* a browser that keeps nothing still has a working cart for this visit */
    }
  }, [saveToAccount]);

  /**
   * `keepAdded`: on arrival the cart is read before the shopper can do anything, but the shop's answer takes a moment and the
   * shopper may already have added something. That must survive the answer. A load caused by another tab is the opposite: whatever
   * that tab removed is gone from here too.
   */
  const load = useCallback(async (saved: SavedCartLine[], options?: { keepAdded?: boolean }) => {
    const keepAdded = options?.keepAdded === true;
    if (saved.length === 0) {
      if (!keepAdded) {
        linesRef.current = [];
        setLines([]);
      }
      setReady(true);
      return;
    }
    try {
      // The quantity goes with each id so the price shown is the price at that quantity.
      const lookup = saved.map((line) => ({ id: line.productId, quantity: line.quantity }));
      const [catalog, packaging] = await Promise.all([
        productsByIdsAction(lookup),
        packagingProductsByIdsAction(lookup),
      ]);
      const fresh = [...catalog, ...packaging];
      const result = reconcileCart(saved, fresh, moneyRef.current);
      commit(keepAdded ? keepAddedDuringLoad(result.lines, linesRef.current, saved) : result.lines);
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
    let cancelled = false;
    const isCancelled = (): boolean => cancelled;
    accountBacked.current = false;
    const start = async () => {
      // The browser's cart is shown at once, whoever is signed in: nothing waits for the account, so whatever the shopper does in the
      // first moments is added to a cart that is already there (adding to a cart still being read would overwrite what was saved).
      await load(readSaved(), { keepAdded: true });
      if (!signedIn || isCancelled()) return;
      // Signed in: the browser's cart joins the account's, and from then on the account keeps it.
      try {
        const browser = readSaved();
        const merged = await mergeServerCartAction(browser.map((line) => ({ productId: line.productId, quantity: line.quantity })));
        if (!merged.ok || isCancelled()) return;
        accountBacked.current = true;
        const priceSeen = new Map(browser.map((line) => [line.productId, line.price]));
        const joined = merged.data.map((line) => ({ productId: line.productId, quantity: line.quantity, price: priceSeen.get(line.productId) ?? null }));
        const here = savedLines(linesRef.current).map((line) => ({ productId: line.productId, quantity: line.quantity }));
        if (sameCartLines(here, merged.data)) {
          // Nothing more from the account; what is here is what the account now keeps.
          saveToAccount(linesRef.current);
        } else {
          await load(joined, { keepAdded: true });
        }
      } catch {
        /* the account could not be reached: this visit works from the browser's cart */
      }
    };
    // The saved cart exists only in the browser, so it can only be read here, after the page is drawn.
    void start();
    const onStorage = (event: StorageEvent) => {
      if (event.key === CART_STORAGE_KEY) void load(readSaved());
    };
    // Coming back to this tab: a cart changed on another device is picked up, unless this tab has a change not yet sent.
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !accountBacked.current || saveTimer.current !== null) return;
      serverCartAction()
        .then((result) => {
          if (!result.ok || result.data === null || saveTimer.current !== null) return;
          const here = savedLines(linesRef.current).map((line) => ({ productId: line.productId, quantity: line.quantity }));
          if (!sameCartLines(here, result.data)) return load(result.data.map((line) => ({ ...line, price: null })));
        })
        .catch(() => undefined);
    };
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, saveToAccount, signedIn]);

  // A price can depend on the quantity (price lists have quantity breaks), so after the shopper changes a quantity the prices are
  // read again, quietly, a moment later: the shopper changed it themselves, so there is nothing to be told.
  const repriceTimer = useRef<number | null>(null);
  const reprice = useCallback(() => {
    if (repriceTimer.current !== null) window.clearTimeout(repriceTimer.current);
    repriceTimer.current = window.setTimeout(() => {
      const current = linesRef.current;
      if (current.length === 0) return;
      const lookup = current.map((line) => ({ id: line.product.id, quantity: line.quantity }));
      Promise.all([productsByIdsAction(lookup), packagingProductsByIdsAction(lookup)])
        .then(([catalog, packaging]) => {
          const fresh = [...catalog, ...packaging];
          const byId = new Map(fresh.map((product) => [product.id, product]));
          commit(linesRef.current.map((line) => ({ product: byId.get(line.product.id) ?? line.product, quantity: line.quantity })));
        })
        .catch(() => undefined);
    }, 400);
  }, [commit]);
  useEffect(
    () => () => {
      if (repriceTimer.current !== null) window.clearTimeout(repriceTimer.current);
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  const add = useCallback(
    (product: PublicProduct, quantity = 1): AddOutcome => {
      const result = addToCart(linesRef.current, product, quantity);
      if (result.outcome !== 'sold_out' && result.outcome !== 'short_of_minimum') {
        commit(result.lines);
        reprice();
      }
      return result.outcome;
    },
    [commit, reprice],
  );
  const setQuantity = useCallback(
    (productId: string, quantity: number) => {
      commit(setCartQuantity(linesRef.current, productId, quantity));
      reprice();
    },
    [commit, reprice],
  );
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
