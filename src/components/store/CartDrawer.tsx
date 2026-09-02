'use client';

import { X, Trash2, ShoppingBag, ArrowRight, ShieldCheck, Truck } from 'lucide-react';
import { type Product } from '@/types/index';

export interface CartItem {
  product: Product;
  quantity: number;
}

interface CartDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  items: CartItem[];
  onUpdateQuantity: (productId: string, quantity: number) => void;
  onRemoveItem: (productId: string) => void;
  onProceedToCheckout: () => void;
}

export function CartDrawer({
  isOpen,
  onClose,
  items,
  onUpdateQuantity,
  onRemoveItem,
  onProceedToCheckout,
}: CartDrawerProps) {
  if (!isOpen) return null;

  const subtotal = items.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
  const tax = Math.round(subtotal * 0.16); // 16% VAT
  const shippingFee = subtotal > 100000 || subtotal === 0 ? 0 : 500;
  const total = subtotal + tax + shippingFee;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="absolute inset-0 bg-black/70 backdrop-blur-sm transition-opacity"
      />

      <div className="fixed inset-y-0 right-0 flex max-w-full pl-10">
        <div className="flex w-screen max-w-md flex-col border-l border-zinc-800 bg-zinc-900 text-zinc-100 shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-zinc-800 p-4 sm:p-6">
            <div className="flex items-center gap-2">
              <ShoppingBag className="h-5 w-5 text-indigo-400" />
              <h2 className="text-base font-bold text-white">Your Shopping Cart</h2>
              <span className="rounded-md border border-indigo-500/20 bg-indigo-500/10 px-2 py-0.5 text-xs font-semibold text-indigo-400">
                {items.length} {items.length === 1 ? 'item' : 'items'}
              </span>
            </div>
            <button
              onClick={onClose}
              className="cursor-pointer rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Cart Items List */}
          <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
            {items.length === 0 ? (
              <div className="space-y-4 py-16 text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-zinc-800 text-zinc-500">
                  <ShoppingBag className="h-8 w-8" />
                </div>
                <h3 className="text-base font-semibold text-white">Your cart is empty</h3>
                <p className="mx-auto max-w-xs text-xs text-zinc-400">
                  Browse our catalog and add items with instant M-Pesa or Pesapal checkout.
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
                const available = product.stockQuantity - product.reservedQuantity;
                return (
                  <div
                    key={product.id}
                    className="flex items-start gap-3.5 rounded-lg border border-zinc-800 bg-zinc-950 p-3.5"
                  >
                    <img
                      src={product.imageUrl}
                      alt={product.name}
                      className="h-16 w-16 shrink-0 rounded-lg bg-zinc-900 object-cover"
                      referrerPolicy="no-referrer"
                    />

                    <div className="min-w-0 flex-1 space-y-1">
                      <h4
                        className="truncate text-xs font-semibold text-white"
                        title={product.name}
                      >
                        {product.name}
                      </h4>
                      <div className="font-mono text-[11px] text-zinc-500">SKU: {product.sku}</div>
                      <div className="font-mono text-xs font-bold text-white">
                        KES {(product.price * quantity).toLocaleString()}
                      </div>

                      {/* Quantity Controls */}
                      <div className="flex items-center justify-between pt-1">
                        <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
                          <button
                            onClick={() => onUpdateQuantity(product.id, quantity - 1)}
                            disabled={quantity <= 1}
                            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-30"
                          >
                            -
                          </button>
                          <span className="w-8 text-center font-mono text-xs font-semibold text-white">
                            {quantity}
                          </span>
                          <button
                            onClick={() => onUpdateQuantity(product.id, quantity + 1)}
                            disabled={quantity >= available}
                            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-30"
                          >
                            +
                          </button>
                        </div>

                        <button
                          onClick={() => onRemoveItem(product.id)}
                          className="cursor-pointer p-1 text-zinc-500 transition-colors hover:text-red-400"
                          title="Remove item"
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

          {/* Footer Summary */}
          {items.length > 0 && (
            <div className="space-y-4 border-t border-zinc-800 bg-zinc-950 p-4 sm:p-6">
              {/* Shipping Progress */}
              <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2.5 text-[11px]">
                {subtotal >= 100000 ? (
                  <div className="flex items-center gap-1.5 font-medium text-emerald-400">
                    <Truck className="h-3.5 w-3.5" /> Congratulations! You unlocked Free Delivery in
                    Kenya.
                  </div>
                ) : (
                  <div className="text-zinc-400">
                    Add{' '}
                    <span className="font-semibold text-white">
                      KES {(100000 - subtotal).toLocaleString()}
                    </span>{' '}
                    more for{' '}
                    <span className="font-semibold text-emerald-400">Free Express Shipping</span>
                  </div>
                )}
              </div>

              {/* Price Breakdown */}
              <div className="space-y-1.5 text-xs text-zinc-400">
                <div className="flex justify-between">
                  <span>Subtotal</span>
                  <span className="font-mono text-zinc-200">KES {subtotal.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span>16% Kenya VAT (eTIMS compliant)</span>
                  <span className="font-mono text-zinc-200">KES {tax.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span>Standard Express Shipping</span>
                  <span className="font-mono text-zinc-200">
                    {shippingFee === 0 ? (
                      <span className="font-semibold text-emerald-400">FREE</span>
                    ) : (
                      `KES ${shippingFee}`
                    )}
                  </span>
                </div>
                <div className="flex justify-between border-t border-zinc-800 pt-2 text-sm font-bold text-white">
                  <span>Total Amount</span>
                  <span className="font-mono text-white">KES {total.toLocaleString()}</span>
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

              <div className="flex items-center justify-center gap-1.5 text-[11px] text-zinc-400">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                <span>Encrypted & 100% Secure Checkout (M-Pesa STK & Card)</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
