'use client';

import { useEffect, useState } from 'react';
import type { PublicProduct } from '@/types/index';
import { productsByIdsAction } from '@/server/domains/catalog/storefront-actions';
import { parseRecentlyViewed, RECENTLY_VIEWED_KEY, viewed } from '@/lib/recently-viewed';
import { ProductRow } from './ProductGrid';

/** Remembers this product in the browser, and shows the others looked at lately. Their current price and stock come from the shop. */
export function RecentlyViewed({ productId }: { productId: string }) {
  const [products, setProducts] = useState<PublicProduct[]>([]);
  useEffect(() => {
    let cancelled = false;
    let ids: string[] = [];
    try {
      ids = parseRecentlyViewed(window.localStorage.getItem(RECENTLY_VIEWED_KEY));
      window.localStorage.setItem(RECENTLY_VIEWED_KEY, JSON.stringify(viewed(ids, productId)));
    } catch {
      /* a browser that keeps nothing simply shows nothing here */
    }
    const others = ids.filter((id) => id !== productId).slice(0, 4);
    if (others.length > 0) {
      productsByIdsAction(others)
        .then((found) => {
          if (!cancelled) setProducts(others.flatMap((id) => found.filter((product) => product.id === id)));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [productId]);
  return <ProductRow title="Recently viewed" products={products} />;
}
