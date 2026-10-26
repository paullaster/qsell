'use client';

import type { CartLine } from '@/lib/cart-lines';
import { cartQuantityWords, perUnitSuffix } from '@/lib/cart-quantity';
import { cartTaxRows, cartTotals } from '@/lib/cartMoney';
import { AppImage } from '@/components/ui/AppImage';
import { useStore } from '@/components/store/StoreContext';

/** The lines of an order with tax, shipping and the total, as the shopper will be charged. */
export function OrderSummary({ lines }: { lines: CartLine[] }) {
  const { money } = useStore();
  const totals = cartTotals(lines);
  const taxRows = cartTaxRows(lines);
  return (
    <div className="space-y-4">
      <ul className="space-y-3" aria-label="Items in your order">
        {lines.map(({ product, quantity }) => (
          <li key={product.id} className="flex items-center justify-between gap-3 text-sm">
            <div className="flex min-w-0 items-center gap-3">
              <AppImage src={product.imageUrl} alt="" width={44} height={44} sizes="44px" className="h-11 w-11 shrink-0 rounded-lg bg-surface-raised object-cover" referrerPolicy="no-referrer" />
              <div className="min-w-0">
                <div className="truncate font-medium text-fg-strong" title={product.name}>{product.name}</div>
                <div className="text-xs text-fg-muted">
                  {cartQuantityWords(quantity, product)} × {money(product.price ?? 0)}
                  {perUnitSuffix(product)}
                </div>
              </div>
            </div>
            <span className="shrink-0 font-mono text-fg-strong">{money(Math.round((product.price ?? 0) * quantity * 100) / 100)}</span>
          </li>
        ))}
      </ul>
      <dl className="space-y-2 border-t border-line pt-3 text-sm text-fg-muted">
        <div className="flex justify-between">
          <dt>Subtotal</dt>
          <dd className="font-mono text-fg-strong">{money(totals.subtotal)}</dd>
        </div>
        {taxRows.map((row) => (
          <div key={row.key} className="flex justify-between gap-3">
            <dt className="min-w-0 truncate">{row.label}</dt>
            <dd className="shrink-0 font-mono text-fg-strong">{money(row.amount)}</dd>
          </div>
        ))}
        {totals.shippingFee > 0 ? (
          <div className="flex justify-between">
            <dt>Shipping</dt>
            <dd className="font-mono text-fg-strong">{money(totals.shippingFee)}</dd>
          </div>
        ) : null}
        <div className="flex justify-between border-t border-line pt-2 text-base font-bold text-fg-strong">
          <dt>Total</dt>
          <dd className="font-mono">{money(totals.totalAmount)}</dd>
        </div>
      </dl>
    </div>
  );
}
