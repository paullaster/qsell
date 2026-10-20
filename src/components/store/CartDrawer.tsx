'use client';

import { X, Trash2, ShoppingBag, ArrowRight, ShieldCheck, LogIn } from 'lucide-react';
import Link from 'next/link';
import { type PublicProduct, type CurrencyConfig } from '@/types/index';
import { cartTaxRows, cartTotals, formatCartAmount } from '@/lib/cartMoney';
import { AppImage } from '@/components/ui/AppImage';
import { QuantityStepper } from '@/components/store/QuantityStepper';
import { availableOf, decimalsOf, perUnitSuffix } from '@/lib/cart-quantity';

export interface CartItem {
  product: PublicProduct;
  quantity: number;
}

interface CartDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  items: CartItem[];
  currency: CurrencyConfig | null;
  paymentLabels: string[];
  isSignedIn: boolean;
  onUpdateQuantity: (productId: string, quantity: number) => void;
  onRemoveItem: (productId: string) => void;
  onProceedToCheckout: () => void;
}

export function CartDrawer({
  isOpen,
  onClose,
  items,
  currency,
  paymentLabels,
  isSignedIn,
  onUpdateQuantity,
  onRemoveItem,
  onProceedToCheckout,
}: CartDrawerProps) {
  if (!isOpen) return null;

  const money = (amount: number) => formatCartAmount(amount, currency);
  const totals = cartTotals(items);
  const taxRows = cartTaxRows(items);
  const checkoutWith =
    paymentLabels.length > 0
      ? `Check out with ${paymentLabels.join(', ')}.`
      : 'Add items when you are ready to check out.';

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      <div
        onClick={onClose}
        className="absolute inset-0 bg-backdrop/70 backdrop-blur-sm transition-opacity"
      />

      <div className="fixed inset-y-0 right-0 flex w-full max-w-full sm:w-auto sm:pl-10">
        <div className="flex h-dvh w-full max-w-full flex-col border-l border-line bg-surface-raised text-fg-strong shadow-2xl sm:h-auto sm:w-screen sm:max-w-md">
          <div className="flex items-center justify-between border-b border-line p-4 sm:p-6">
            <div className="flex min-w-0 items-center gap-2">
              <ShoppingBag className="h-5 w-5 text-indigo-400" />
              <h2 className="truncate text-sm font-bold text-fg-strong sm:text-base">Your Cart</h2>
              <span className="shrink-0 rounded-md border border-indigo-500/20 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-semibold text-indigo-400 sm:text-xs">
                {items.length} {items.length === 1 ? 'item' : 'items'}
              </span>
            </div>
            <button
              onClick={onClose}
              className="cursor-pointer rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-hover hover:text-fg-strong"
              aria-label="Close cart"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
            {items.length === 0 ? (
              <div className="space-y-4 py-16 text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-surface-sunken text-fg-subtle">
                  <ShoppingBag className="h-8 w-8" />
                </div>
                <h3 className="text-base font-semibold text-fg-strong">Your cart is empty</h3>
                <p className="mx-auto max-w-xs text-xs text-fg-muted">
                  Browse the catalog. {checkoutWith}
                </p>
                <button
                  onClick={onClose}
                  className="cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white shadow-md transition-colors hover:bg-indigo-500"
                >
                  Continue Shopping
                </button>
              </div>
            ) : (
              items.map(({ product, quantity }) => {
                const available = availableOf(product);
                const lineAmount = Math.round((product.price ?? 0) * quantity * 100) / 100;
                return (
                  <div
                    key={product.id}
                    className="flex items-start gap-3.5 rounded-lg border border-line bg-surface p-3.5"
                  >
                    <AppImage
                      src={product.imageUrl}
                      alt={product.name}
                      width={64}
                      height={64}
                      sizes="64px"
                      className="h-16 w-16 shrink-0 rounded-lg bg-surface-raised object-cover"
                      referrerPolicy="no-referrer"
                    />

                    <div className="min-w-0 flex-1 space-y-1">
                      <h4
                        className="truncate text-xs font-semibold text-fg-strong"
                        title={product.name}
                      >
                        {product.name}
                      </h4>
                      <div className="font-mono text-[11px] text-fg-subtle">SKU: {product.sku}</div>
                      <div className="font-mono text-xs font-bold text-fg-strong">
                        {money(lineAmount)}
                        <span className="font-normal text-fg-subtle">
                          {' '}
                          @ {money(product.price ?? 0)}
                          {perUnitSuffix(product)}
                        </span>
                      </div>

                      <div className="flex items-center justify-between pt-1">
                        <QuantityStepper
                          label={`quantity of ${product.name}`}
                          value={quantity}
                          decimals={decimalsOf(product)}
                          unitCode={product.baseUnitCode}
                          available={available}
                          onChange={(next) => onUpdateQuantity(product.id, next)}
                        />

                        <button
                          onClick={() => onRemoveItem(product.id)}
                          className="flex h-10 w-10 cursor-pointer items-center justify-center text-fg-subtle transition-colors hover:text-red-600"
                          title="Remove item"
                          aria-label={`Remove ${product.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {items.length > 0 && (
            <div className="space-y-4 border-t border-line bg-surface p-4 sm:p-6">
              {!isSignedIn ? (
                <div className="rounded-xl border border-indigo-500/25 bg-indigo-500/5 p-3.5 sm:p-4">
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white">
                      <LogIn className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-fg-strong">Already have an account?</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
                        Sign in to use your saved details. Your cart will be here when you return.
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                        <Link
                          href="/login?callbackUrl=%2F"
                          className="inline-flex min-h-10 touch-manipulation items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
                        >
                          Sign in
                        </Link>
                        <Link
                          href="/register?callbackUrl=%2F"
                          className="min-h-10 touch-manipulation content-center text-xs font-medium text-indigo-600 underline underline-offset-2 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
                        >
                          Create account
                        </Link>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="space-y-1.5 text-xs text-fg-muted">
                <div className="flex justify-between">
                  <span>Subtotal</span>
                  <span className="font-mono text-fg-strong">{money(totals.subtotal)}</span>
                </div>
                {taxRows.map((row) => (
                  <div key={row.key} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate">{row.label}</span>
                    <span className="shrink-0 font-mono text-fg-strong">{money(row.amount)}</span>
                  </div>
                ))}
                {totals.shippingFee > 0 ? (
                  <div className="flex justify-between">
                    <span>Shipping</span>
                    <span className="font-mono text-fg-strong">{money(totals.shippingFee)}</span>
                  </div>
                ) : null}
                <div className="flex justify-between border-t border-line pt-2 text-sm font-bold text-fg-strong">
                  <span>Total</span>
                  <span className="font-mono text-fg-strong">{money(totals.totalAmount)}</span>
                </div>
              </div>

              <button
                onClick={() => {
                  onClose();
                  onProceedToCheckout();
                }}
                className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 text-xs font-bold text-white shadow-lg shadow-indigo-600/20 transition-all hover:bg-indigo-500 active:scale-98"
              >
                Proceed to Secure Checkout
                <ArrowRight className="h-4 w-4" />
              </button>

              <div className="flex items-center justify-center gap-1.5 text-center text-[11px] text-fg-muted">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                <span>
                  {paymentLabels.length > 0
                    ? `Secure checkout with ${paymentLabels.join(' · ')}`
                    : 'Secure checkout'}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
