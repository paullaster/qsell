'use client';

import { useState } from 'react';
import { ShoppingCart, Zap } from 'lucide-react';
import type { PublicProduct } from '@/types/index';
import { availableOf, clampCartQuantity, decimalsOf } from '@/lib/cart-quantity';
import { limitsHint, limitsOf, startingQuantity } from '@/lib/quantity-limits';
import { QuantityStepper } from '@/components/store/QuantityStepper';
import { useCartActions } from '@/components/store/cart/useCartActions';

/** Choose how many and add to the cart, or go straight to checkout. */
export function ProductPurchase({ product }: { product: PublicProduct }) {
  const limits = limitsOf(product);
  const available = availableOf(product);
  // The quantity starts at the least that may be bought (one when there is no minimum).
  const [quantity, setQuantity] = useState(() => {
    const start = clampCartQuantity(startingQuantity(limits), decimalsOf(product), available, limits);
    return start === 0 ? 1 : start;
  });
  const { addToCart, buyNow } = useCartActions();
  if (available <= 0) {
    return <p className="rounded-xl border border-line bg-surface p-4 text-sm font-medium text-fg-muted">This product is sold out right now. Please check back soon.</p>;
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-fg-muted">Quantity</span>
        <QuantityStepper
          label={`quantity of ${product.name}`}
          value={quantity}
          decimals={decimalsOf(product)}
          unitCode={product.baseUnitCode}
          available={available}
          limits={limits}
          onChange={setQuantity}
        />
      </div>
      {limitsHint(limits, product.baseUnitName) === '' ? null : <p className="text-xs text-fg-muted">{limitsHint(limits, product.baseUnitName)}</p>}
      <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
        <button
          type="button"
          onClick={() => addToCart(product, quantity)}
          className="flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl border border-line-strong bg-surface-sunken px-4 py-2.5 text-sm font-semibold text-fg-strong transition-colors hover:bg-hover"
        >
          <ShoppingCart className="h-4 w-4 text-indigo-400" aria-hidden="true" />
          Add to cart
        </button>
        <button
          type="button"
          onClick={() => buyNow(product, quantity)}
          className="flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-indigo-600/20 transition-all hover:bg-indigo-500"
        >
          <Zap className="h-4 w-4" aria-hidden="true" />
          Buy now
        </button>
      </div>
    </div>
  );
}
