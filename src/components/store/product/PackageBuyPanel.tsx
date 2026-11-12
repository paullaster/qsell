'use client';

import { Suspense, use } from 'react';
import type { PublicProduct } from '@/types/index';
import type { ShopBuilder } from '@/server/domains/pricing/package-shop-service';
import { ProductPurchase } from '@/components/store/product/ProductPurchase';
import { PackageBuilder } from '@/components/store/product/PackageBuilder';

function Choice({ product, builder }: { product: PublicProduct; builder: Promise<ShopBuilder | null> }) {
  const found = use(builder);
  // An ordinary product keeps its ordinary purchase panel.
  if (found === null) return <ProductPurchase product={product} />;
  if (!found.offered) {
    return <p role="status" className="rounded-xl border border-line bg-surface p-4 text-sm font-medium text-fg-muted">{product.name} is not available right now. Please check back soon.</p>;
  }
  return <PackageBuilder productName={product.name} builder={found} />;
}

/**
 * The buy panel of a product page. The page does not wait to know whether the product is a package: the answer streams in here
 * (package choices, and what stock allows) while the rest of the page is already on screen.
 */
export function PackageBuyPanel({ product, builder }: { product: PublicProduct; builder: Promise<ShopBuilder | null> }) {
  return (
    <Suspense fallback={<div aria-busy="true" aria-label="Loading your choices" className="h-40 animate-pulse rounded-xl bg-surface-sunken" />}>
      <Choice product={product} builder={builder} />
    </Suspense>
  );
}
