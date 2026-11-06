'use client';

import { useCallback, useMemo, useState } from 'react';
import { useProductUpdated } from '@/components/admin/product-updated';
import { buildCatalogueIndex, type CatalogueProduct } from '@/lib/catalogue-entry';
import { getQuoteCatalogueProductAction } from '@/server/domains/quotes/actions';

/**
 * The catalogue a template editor works from, kept current when a product is saved from a line's Edit shortcut:
 * the product is read again, so the editor shows its new name, price and cost without being reopened.
 * Only products already in the editor's catalogue are read again.
 */
export function useRefreshedProducts(products: CatalogueProduct[], onRefreshed?: (product: CatalogueProduct) => void) {
  const [refreshed, setRefreshed] = useState<Record<string, CatalogueProduct>>({});
  const current = useMemo(() => products.map((p) => refreshed[p.id] ?? p), [products, refreshed]);
  const known = useMemo(() => new Set(products.map((p) => p.id)), [products]);
  const productSaved = useCallback(
    (productId: string) => {
      if (!known.has(productId)) return;
      void getQuoteCatalogueProductAction(productId)
        .then((fresh) => {
          if (fresh === null) return;
          setRefreshed((r) => ({ ...r, [fresh.id]: fresh }));
          onRefreshed?.(fresh);
        })
        .catch(() => undefined);
    },
    [known, onRefreshed],
  );
  useProductUpdated(productSaved);
  const catalogueIndex = useMemo(() => buildCatalogueIndex(current), [current]);
  const productById = useMemo(() => new Map(current.map((p) => [p.id, p])), [current]);
  return { current, catalogueIndex, productById };
}
