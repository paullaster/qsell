import { availableOf, cartQuantityWords } from '@/lib/cart-quantity';
import type { PublicProduct } from '@/types/index';

/** Whether a product can be bought: sold out, nearly gone (with how many are left), or in stock. */
export function StockBadge({ product }: { product: PublicProduct }) {
  const available = availableOf(product);
  if (available <= 0) {
    return <span className="inline-flex items-center rounded-md border border-line-strong bg-surface-sunken px-2.5 py-1 text-xs font-bold text-destructive">Sold out</span>;
  }
  if (available <= product.lowStockThreshold) {
    return (
      <span className="inline-flex items-center rounded-md border border-line-strong bg-surface-sunken px-2.5 py-1 text-xs font-bold text-amber-700 dark:text-amber-400">
        Only {cartQuantityWords(available, product)} left
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface/90 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
      In stock
    </span>
  );
}
