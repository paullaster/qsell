'use client';

import { use } from 'react';
import type { PublicProduct } from '@/types/index';
import { ProductRow } from './ProductGrid';

export function RelatedProducts({ productsPromise }: { productsPromise: Promise<PublicProduct[]> }) {
  return <ProductRow title="You may also like" products={use(productsPromise)} />;
}
