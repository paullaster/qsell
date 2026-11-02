'use client';

import { useEffect, useMemo, useState } from 'react';
import { PackagePlus } from 'lucide-react';
import type { PublicProduct } from '@/types/index';
import { packagingForProductsAction } from '@/server/domains/catalog/storefront-actions';
import { suggestPackaging, type PackagingFit } from '@/lib/packaging-suggestions';
import { useCart } from '@/components/store/cart/CartProvider';
import { useStore } from '@/components/store/StoreContext';
import { QuantityStepper } from '@/components/store/QuantityStepper';
import { availableOf } from '@/lib/cart-quantity';
import { isInventoryManaged } from '@/lib/inventory-kind';

interface PackagingOffer {
  product: PublicProduct;
  productId: string;
  capacity: number;
}

/** Cart/checkout add-on picker. Offer quantities come from seller fit rules, never shopper-supplied pricing. */
export function PackagingOptions() {
  const { lines, add, setQuantity } = useCart();
  const { money } = useStore();
  const [offers, setOffers] = useState<PackagingOffer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const productIds = useMemo(
    () =>
      lines
        .filter((line) => line.product.isCheckoutPackaging !== true && isInventoryManaged(line.product))
        .map((line) => line.product.id)
        .sort(),
    [lines],
  );
  const key = productIds.join('|');

  useEffect(() => {
    let current = true;
    if (key === '')
      return () => {
        current = false;
      };
    packagingForProductsAction(key.split('|'))
      .then((result) => {
        if (current) {
          setOffers(result);
          setError(null);
        }
      })
      .catch(() => {
        if (current) setError('Packaging options could not be loaded. Try again in a moment.');
      });
    return () => {
      current = false;
    };
  }, [key]);

  const goods = lines.filter((line) => line.product.isCheckoutPackaging !== true && isInventoryManaged(line.product));
  const fits: PackagingFit[] = offers.map(({ product, productId, capacity }) => ({
    productId,
    packagingProductId: product.id,
    capacity,
  }));
  const suggestions = suggestPackaging(
    goods.map((line) => ({ productId: line.product.id, quantity: line.quantity })),
    fits,
  );
  const offerById = new Map(offers.map((offer) => [offer.product.id, offer.product]));
  if (goods.length === 0) return null;

  return (
    <section
      className="space-y-3 rounded-xl border border-line bg-surface-raised p-4"
      aria-labelledby="packaging-options-title"
    >
      <div className="flex items-start gap-2">
        <PackagePlus className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" aria-hidden="true" />
        <div>
          <h3 id="packaging-options-title" className="text-sm font-semibold text-fg-strong">
            Packaging (optional)
          </h3>
          <p className="text-xs text-fg-muted">
            Suggested amounts are based on the shop’s fit and capacity settings.
          </p>
        </div>
      </div>
      {error !== null ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {suggestions.length === 0 && error === null ? (
        <p className="text-sm text-fg-muted">
          No configured packaging options fit the products in your cart.
        </p>
      ) : null}
      <ul className="space-y-2">
        {suggestions.map((suggestion) => {
          const product = offerById.get(suggestion.packagingProductId);
          if (product === undefined) return null;
          const existing = lines.find((line) => line.product.id === product.id);
          const available = availableOf(product);
          const enoughStock = available >= suggestion.quantity;
          return (
            <li
              key={product.id}
              className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="font-medium text-fg-strong">{product.name}</p>
                <p className="text-xs text-fg-muted">
                  {money(product.price ?? 0)} each · suggested {suggestion.quantity}
                </p>
                {suggestion.uncoveredProductIds.length > 0 ? (
                  <p className="mt-1 text-xs text-amber-700">
                    Some cart products have no configured package fit.
                  </p>
                ) : null}
                {!enoughStock ? (
                  <p className="mt-1 text-xs text-amber-700">
                    Only {available} in stock; this option cannot safely package the order quantity.
                  </p>
                ) : null}
              </div>
              {existing === undefined ? (
                <button
                  type="button"
                  disabled={!enoughStock}
                  onClick={() => add(product, suggestion.quantity)}
                  className="min-h-11 shrink-0 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {!enoughStock ? 'Not enough in stock' : `Add ${suggestion.quantity} suggested`}
                </button>
              ) : (
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-xs text-fg-muted">Added</span>
                  <QuantityStepper
                    label={`quantity of ${product.name}`}
                    value={existing.quantity}
                    decimals={0}
                    unitCode="package"
                    available={available}
                    onChange={(quantity) =>
                      setQuantity(
                        product.id,
                        quantity === 0 ? 0 : Math.max(suggestion.quantity, quantity),
                      )
                    }
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
