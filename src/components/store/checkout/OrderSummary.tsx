'use client';

import type { CartLine } from '@/lib/cart-lines';
import { cartQuantityWords, perUnitSuffix } from '@/lib/cart-quantity';
import { cartTaxRows, cartTotals } from '@/lib/cartMoney';
import { AppImage } from '@/components/ui/AppImage';
import { useStore } from '@/components/store/StoreContext';
import type { ShopBasketView } from '@/server/domains/orders/shop-basket-actions';

/** The lines of an order with tax, shipping and the total, as the shopper will be charged. */
export function OrderSummary({ lines, packages = [], basket = null, delivery = null, collecting = false }: { lines: CartLine[]; /** Package lines as the shop priced them, to be listed with the rest. */ packages?: { id: string; summary: string; servings: number; total: number }[]; /** What the server says the basket comes to, with promotions; the figures below use it when it is there. */ basket?: ShopBasketView | null; delivery?: { gross: number; net: number; tax: number; branchName: string } | null; /** The order is collected from the branch, not delivered. */ collecting?: boolean }) {
  const { money } = useStore();
  const baseTotals = cartTotals(lines);
  // Until the server has answered, a package is shown at the price the shop gave it; its tax is worked out by the server.
  const packageSum = packages.reduce((n, p) => n + p.total, 0);
  const totals = { ...baseTotals, subtotal: baseTotals.subtotal + packageSum, totalAmount: baseTotals.totalAmount + packageSum };
  const taxRows = basket === null ? cartTaxRows(lines) : [{ key: 'tax', label: 'Tax', amount: basket.tax }];
  const subtotal = basket === null ? totals.subtotal : basket.subtotal;
  const goodsTotal = basket === null ? totals.totalAmount : basket.goodsTotal;
  const promotions = basket?.promotions ?? null;
  return (
    <div className="space-y-4">
      <ul className="space-y-3" aria-label="Items in your order">
        {packages.map((p) => (
          <li key={p.id} data-testid="summary-package" className="flex items-center justify-between gap-3 text-sm">
            <div className="min-w-0">
              <div className="font-medium break-words text-fg-strong">{p.summary}</div>
              <div className="text-xs text-fg-muted">{p.servings} {p.servings === 1 ? 'serving' : 'servings'}</div>
            </div>
            <span className="shrink-0 font-mono text-fg-strong">{money(p.total)}</span>
          </li>
        ))}
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
          <dt>{promotions !== null && promotions.discount > 0 ? 'Subtotal after promotions' : 'Subtotal'}</dt>
          <dd className="font-mono text-fg-strong">{money(subtotal)}</dd>
        </div>
        {promotions === null || promotions.discount <= 0 ? null : (
          <div className="flex justify-between gap-3 text-emerald-700 dark:text-emerald-400">
            <dt className="min-w-0 truncate">Promotions{promotions.applied.length === 0 ? '' : ` (${promotions.applied.map((a) => a.code).join(', ')})`}</dt>
            <dd className="shrink-0 font-mono">you save {money(promotions.discount)}</dd>
          </div>
        )}
        {promotions === null || promotions.gifts.length === 0 ? null : (
          <div className="text-emerald-700 dark:text-emerald-400">
            <dt className="sr-only">Free gifts</dt>
            <dd>{promotions.gifts.map((g) => `${String(g.quantity)} × ${g.name} free`).join(', ')}</dd>
          </div>
        )}
        {taxRows.map((row) => (
          <div key={row.key} className="flex justify-between gap-3">
            <dt className="min-w-0 truncate">{row.label}</dt>
            <dd className="shrink-0 font-mono text-fg-strong">{money(row.amount)}</dd>
          </div>
        ))}
        {delivery === null ? null : (
          <div className="flex justify-between gap-3">
            <dt className="min-w-0 truncate">{collecting ? 'Collect from' : 'Delivery from'} {delivery.branchName}</dt>
            <dd className="shrink-0 font-mono text-fg-strong">{delivery.gross === 0 ? 'Free' : money(delivery.gross)}</dd>
          </div>
        )}
        {totals.shippingFee > 0 ? (
          <div className="flex justify-between">
            <dt>Shipping</dt>
            <dd className="font-mono text-fg-strong">{money(totals.shippingFee)}</dd>
          </div>
        ) : null}
        <div className="flex justify-between border-t border-line pt-2 text-base font-bold text-fg-strong">
          <dt>Total</dt>
          <dd className="font-mono">{money(goodsTotal + (delivery?.gross ?? 0))}</dd>
        </div>
      </dl>
    </div>
  );
}
