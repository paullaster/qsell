'use client';

import { X, Trash2, ShoppingBag, ArrowRight, ShieldCheck, Truck } from 'lucide-react';
import { Product } from '@/types/index';

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
  onProceedToCheckout
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

      <div className="fixed inset-y-0 right-0 max-w-full flex pl-10">
        <div className="w-screen max-w-md bg-zinc-900 border-l border-zinc-800 text-zinc-100 flex flex-col shadow-2xl">
          {/* Header */}
          <div className="p-4 sm:p-6 border-b border-zinc-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShoppingBag className="w-5 h-5 text-indigo-400" />
              <h2 className="font-bold text-base text-white">Your Shopping Cart</h2>
              <span className="px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-400 text-xs font-semibold border border-indigo-500/20">
                {items.length} {items.length === 1 ? 'item' : 'items'}
              </span>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Cart Items List */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
            {items.length === 0 ? (
              <div className="text-center py-16 space-y-4">
                <div className="w-16 h-16 rounded-full bg-zinc-800 flex items-center justify-center mx-auto text-zinc-500">
                  <ShoppingBag className="w-8 h-8" />
                </div>
                <h3 className="font-semibold text-white text-base">Your cart is empty</h3>
                <p className="text-xs text-zinc-400 max-w-xs mx-auto">
                  Browse our catalog and add items with instant M-Pesa or Pesapal checkout.
                </p>
                <button
                  onClick={onClose}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs rounded-lg shadow-md transition-colors cursor-pointer"
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
                    className="flex gap-3.5 p-3.5 rounded-lg bg-zinc-950 border border-zinc-800 items-start"
                  >
                    <img
                      src={product.imageUrl}
                      alt={product.name}
                      className="w-16 h-16 object-cover rounded-lg bg-zinc-900 shrink-0"
                      referrerPolicy="no-referrer"
                    />

                    <div className="flex-1 min-w-0 space-y-1">
                      <h4 className="text-xs font-semibold text-white truncate" title={product.name}>
                        {product.name}
                      </h4>
                      <div className="text-[11px] text-zinc-500 font-mono">
                        SKU: {product.sku}
                      </div>
                      <div className="text-xs font-bold text-white font-mono">
                        KES {(product.price * quantity).toLocaleString()}
                      </div>

                      {/* Quantity Controls */}
                      <div className="flex items-center justify-between pt-1">
                        <div className="flex items-center bg-zinc-900 rounded-lg border border-zinc-800 p-0.5">
                          <button
                            onClick={() => onUpdateQuantity(product.id, quantity - 1)}
                            disabled={quantity <= 1}
                            className="w-6 h-6 flex items-center justify-center rounded text-zinc-300 hover:bg-zinc-800 disabled:opacity-30 text-xs cursor-pointer"
                          >
                            -
                          </button>
                          <span className="w-8 text-center text-xs font-mono font-semibold text-white">
                            {quantity}
                          </span>
                          <button
                            onClick={() => onUpdateQuantity(product.id, quantity + 1)}
                            disabled={quantity >= available}
                            className="w-6 h-6 flex items-center justify-center rounded text-zinc-300 hover:bg-zinc-800 disabled:opacity-30 text-xs cursor-pointer"
                          >
                            +
                          </button>
                        </div>

                        <button
                          onClick={() => onRemoveItem(product.id)}
                          className="text-zinc-500 hover:text-red-400 p-1 transition-colors cursor-pointer"
                          title="Remove item"
                        >
                          <Trash2 className="w-4 h-4" />
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
            <div className="p-4 sm:p-6 border-t border-zinc-800 bg-zinc-950 space-y-4">
              {/* Shipping Progress */}
              <div className="p-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-[11px]">
                {subtotal >= 100000 ? (
                  <div className="flex items-center gap-1.5 text-emerald-400 font-medium">
                    <Truck className="w-3.5 h-3.5" /> Congratulations! You unlocked Free Delivery in Kenya.
                  </div>
                ) : (
                  <div className="text-zinc-400">
                    Add <span className="font-semibold text-white">KES {(100000 - subtotal).toLocaleString()}</span> more for <span className="text-emerald-400 font-semibold">Free Express Shipping</span>
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
                    {shippingFee === 0 ? <span className="text-emerald-400 font-semibold">FREE</span> : `KES ${shippingFee}`}
                  </span>
                </div>
                <div className="flex justify-between text-sm font-bold text-white pt-2 border-t border-zinc-800">
                  <span>Total Amount</span>
                  <span className="text-white font-mono">KES {total.toLocaleString()}</span>
                </div>
              </div>

              <button
                onClick={() => {
                  onClose();
                  onProceedToCheckout();
                }}
                className="w-full py-3 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 transition-all active:scale-98 cursor-pointer"
              >
                Proceed to Secure Checkout
                <ArrowRight className="w-4 h-4" />
              </button>

              <div className="flex items-center justify-center gap-1.5 text-[11px] text-zinc-400">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                <span>Encrypted & 100% Secure Checkout (M-Pesa STK & Card)</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
