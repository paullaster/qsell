'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  mergeWishlistAction,
  setWishlistAction,
  wishlistIdsAction,
} from '@/server/domains/wishlist/actions';
import { mergeWishlists, parseWishlist, WISHLIST_KEY, withProduct } from '@/lib/wishlist';
import { useStore } from '@/components/store/StoreContext';
import { useToast } from '@/components/store/ToastProvider';

interface WishlistValue {
  ids: string[];
  ready: boolean;
  has: (productId: string) => boolean;
  toggle: (productId: string, name: string) => void;
}

const WishlistContext = createContext<WishlistValue | null>(null);

function readLocal(): string[] {
  try {
    return parseWishlist(window.localStorage.getItem(WISHLIST_KEY));
  } catch {
    return [];
  }
}
function writeLocal(ids: string[]): void {
  try {
    if (ids.length === 0) window.localStorage.removeItem(WISHLIST_KEY);
    else window.localStorage.setItem(WISHLIST_KEY, JSON.stringify(ids));
  } catch {
    /* a browser that keeps nothing still has a list for this visit */
  }
}

/**
 * Saved products. A signed-in shopper's list lives on their account (so it follows them to another phone); a guest's
 * stays in this browser and joins the account's list when they sign in.
 */
export function WishlistProvider({ children }: { children: ReactNode }) {
  const { sessionName } = useStore();
  const toast = useToast();
  const signedIn = sessionName !== null;
  const [ids, setIds] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const idsRef = useRef<string[]>([]);
  const accountBacked = useRef(false);
  const commit = useCallback((next: string[]) => {
    idsRef.current = next;
    setIds(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    const start = async () => {
      accountBacked.current = false;
      if (!signedIn) {
        if (!cancelled) commit(readLocal());
        if (!cancelled) setReady(true);
        return;
      }
      try {
        const account = await wishlistIdsAction();
        if (isCancelled()) return;
        if (!account.ok || account.data === null) {
          commit(readLocal());
          return;
        }

        const guest = readLocal();
        // A guest list saved before signing in joins the account's, once.
        const merged = guest.length > 0 ? await mergeWishlistAction(guest) : account;
        if (isCancelled()) return;
        if (merged.ok && merged.data !== null) {
          accountBacked.current = true;
          commit(merged.data);
          if (guest.length > 0) writeLocal([]);
        } else {
          // Keep both lists in this browser if an account merge is temporarily unavailable.
          commit(mergeWishlists(guest, account.data));
          writeLocal(mergeWishlists(guest, account.data));
        }
      } catch {
        // Keep browsing usable with this browser's saved list if account sync is unavailable.
        if (!cancelled) commit(readLocal());
      } finally {
        if (!cancelled) setReady(true);
      }
    };
    void start();
    return () => {
      cancelled = true;
    };
  }, [signedIn, commit]);

  const toggle = useCallback(
    (productId: string, name: string) => {
      const on = !idsRef.current.includes(productId);
      const before = idsRef.current;
      const next = withProduct(before, productId, on);
      commit(next);
      toast({
        type: 'success',
        title: on ? 'Saved' : 'Removed',
        message: on
          ? `${name} is in your saved products.`
          : `${name} was removed from your saved products.`,
      });
      if (!accountBacked.current) {
        writeLocal(next);
        return;
      }
      setWishlistAction({ productId, on })
        .then((result) => {
          if (!result.ok) {
            commit(before);
            toast({ type: 'error', title: 'Could not save', message: result.error });
            return;
          }
          commit(result.data);
        })
        .catch(() => {
          commit(before);
          toast({
            type: 'error',
            title: 'Could not save',
            message: 'Your saved products were not changed. Please try again.',
          });
        });
    },
    [commit, toast],
  );

  const value = useMemo<WishlistValue>(
    () => ({ ids, ready, has: (productId) => ids.includes(productId), toggle }),
    [ids, ready, toggle],
  );
  return <WishlistContext.Provider value={value}>{children}</WishlistContext.Provider>;
}

export function useWishlist(): WishlistValue {
  const value = useContext(WishlistContext);
  if (value === null) throw new Error('useWishlist must be used inside <WishlistProvider>.');
  return value;
}
