'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Heart } from 'lucide-react';
import type { PublicProduct } from '@/types/index';
import { productsByIdsAction } from '@/server/domains/catalog/storefront-actions';
import { ProductCard } from '@/components/store/ProductCard';
import { useWishlist } from '@/components/store/wishlist/WishlistProvider';

/** The products a shopper saved, with today's price and stock. Ones no longer for sale simply do not appear. */
export function WishlistScreen() {
  const wishlist = useWishlist();
  const [products, setProducts] = useState<PublicProduct[] | null>(null);
  const [failed, setFailed] = useState(false);
  const key = wishlist.ids.join(',');

  useEffect(() => {
    if (!wishlist.ready) return;
    if (key === '') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- nothing saved, nothing to fetch
      setProducts([]);
      return;
    }
    let cancelled = false;
    productsByIdsAction(key.split(','))
      .then((found) => {
        if (!cancelled) setProducts(key.split(',').flatMap((id) => found.filter((product) => product.id === id)));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [key, wishlist.ready]);

  return (
    <div className="space-y-6 pb-16">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-fg-strong sm:text-3xl">Saved products</h1>
        <p className="text-sm text-fg-muted">Products you saved for later. Sign in to keep them on your account and see them on any device.</p>
      </header>
      {failed ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">Your saved products could not be loaded. Please try again.</p> : null}
      {products === null && !failed ? <p role="status" className="text-sm text-fg-muted">Loading your saved products…</p> : null}
      {products !== null && products.length === 0 ? (
        <div className="mx-auto max-w-md space-y-4 rounded-2xl border border-line bg-surface-raised p-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-surface-sunken text-rose-500"><Heart className="h-7 w-7" aria-hidden="true" /></div>
          <h2 className="text-lg font-semibold text-fg-strong">Nothing saved yet</h2>
          <p className="text-sm text-fg-muted">Tap the heart on a product to keep it here.</p>
          <Link href="/" className="inline-flex min-h-11 items-center rounded-lg bg-indigo-600 px-5 text-sm font-semibold text-white hover:bg-indigo-500">Browse the shop</Link>
        </div>
      ) : null}
      {products !== null && products.length > 0 ? (
        <ul aria-label="Saved products" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {products.map((product) => (
            <li key={product.id} className="contents"><ProductCard product={product} /></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
