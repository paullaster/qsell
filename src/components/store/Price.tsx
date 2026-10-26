'use client';

import type { PublicProduct } from '@/types/index';
import { perUnitSuffix } from '@/lib/cart-quantity';
import { useStore } from '@/components/store/StoreContext';

/** A product's price in the shop's currency, with the unit it is sold by and any saving shown beside it. */
export function Price({ product, size = 'md' }: { product: PublicProduct; size?: 'md' | 'lg' }) {
  const { money } = useStore();
  const price = product.price ?? 0;
  const was = product.compareAtPrice;
  const saving = was !== undefined && product.price !== undefined && was > price ? was - price : 0;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className={`font-mono font-bold text-fg-strong ${size === 'lg' ? 'text-2xl' : 'text-base'}`}>
        {money(price)}
        {perUnitSuffix(product) === '' ? null : <span className="text-sm font-normal text-fg-muted">{perUnitSuffix(product)}</span>}
      </span>
      {saving > 0 && was !== undefined ? (
        <>
          <span className="font-mono text-sm text-fg-subtle line-through">
            <span className="sr-only">Was </span>
            {money(was)}
          </span>
          <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">Save {money(saving)}</span>
        </>
      ) : null}
    </div>
  );
}
