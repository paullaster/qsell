'use client';

import type { PublicProduct } from '@/types/index';
import { ProductCard } from '@/components/store/ProductCard';

/** A short row of products under a heading (related, recently viewed). */
export function ProductRow({ title, products }: { title: string; products: PublicProduct[] }) {
  if (products.length === 0) return null;
  return (
    <section aria-label={title} className="space-y-4">
      <h2 className="text-xl font-bold text-fg-strong">{title}</h2>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {products.map((product) => (
          <li key={product.id} className="contents">
            <ProductCard product={product} />
          </li>
        ))}
      </ul>
    </section>
  );
}
