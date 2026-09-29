'use client';

import React, { useState, useCallback, useEffect, Suspense, use } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Navbar } from '@/components/layout/Navbar';
import { Footer } from '@/components/layout/Footer';
import { StorefrontView } from '@/components/store/StorefrontView';
import { CartDrawer, type CartItem } from '@/components/store/CartDrawer';
import { CheckoutModal } from '@/components/store/CheckoutModal';
import { MpesaStkModal } from '@/components/store/MpesaStkModal';
import { PesapalCheckoutModal } from '@/components/store/PesapalCheckoutModal';
import { OrderSuccessModal } from '@/components/store/OrderSuccessModal';
import { OrderTrackerModal } from '@/components/store/OrderTrackerModal';
import { CustomerHelpModal } from '@/components/store/CustomerHelpModal';
import { CustomerAccountModal } from '@/components/customer/CustomerAccountModal';
import { Toast, type ToastNotification } from '@/components/ui/Toast';
import { useRealtimeEvents } from '@/lib/realtime';
import {
  createOrderAction,
  initiateBranchPaymentAction,
  getSessionAction,
  listCurrenciesAction,
  listEnabledCheckoutProvidersAction,
} from '@/server/actions';
import type { Product, Order, PaymentProvider, CurrencyConfig } from '@/types/index';
import { resolveBaseCurrency } from '@/lib/cartMoney';
import type { CompanySettingsRow } from '@/server/db/drizzle/schema';

interface StorefrontPageClientProps {
  productsPromise: Promise<Product[]>;
  companyPromise: Promise<CompanySettingsRow>;
}

export function StorefrontPageClient({
  productsPromise,
  companyPromise,
}: StorefrontPageClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const company = use(companyPromise);

  const [toasts, setToasts] = useState<ToastNotification[]>([]);
  const addToast = useCallback((toast: Omit<ToastNotification, 'id'>) => {
    const newId = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev, { ...toast, id: newId }]);
  }, []);
  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const refresh = useCallback(() => router.refresh(), [router]);

  useRealtimeEvents(() => {
    refresh();
  });

  useEffect(() => {
    if (searchParams.get('admin') !== '1') return;
    router.replace('/login?callbackUrl=/admin');
  }, [searchParams, router]);

  const [sessionName, setSessionName] = useState<string | null>(null);
  const [currency, setCurrency] = useState<CurrencyConfig | null>(null);
  const [paymentLabels, setPaymentLabels] = useState<string[]>([]);
  useEffect(() => {
    getSessionAction()
      .then(({ session }) => setSessionName(session?.name || null))
      .catch(() => setSessionName(null));
    listCurrenciesAction()
      .then((currencies) => setCurrency(resolveBaseCurrency(currencies)))
      .catch(() => setCurrency(null));
    listEnabledCheckoutProvidersAction()
      .then((providers) => setPaymentLabels(providers.map((provider) => provider.label)))
      .catch(() => setPaymentLabels([]));
  }, []);

  const [cart, setCart] = useState<CartItem[]>([]);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('omnicommerce_cart');
      if (saved) setCart(JSON.parse(saved));
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('omnicommerce_cart', JSON.stringify(cart));
    } catch {
      /* ignore */
    }
  }, [cart]);

  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [isCheckoutSubmitting, setIsCheckoutSubmitting] = useState(false);
  const [isTrackOrderOpen, setIsTrackOrderOpen] = useState(false);
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');

  const [isMpesaModalOpen, setIsMpesaModalOpen] = useState(false);
  const [activeOrder, setActiveOrder] = useState<Order | null>(null);
  const [mpesaCheckoutRequestId, setMpesaCheckoutRequestId] = useState('');
  const [isPesapalModalOpen, setIsPesapalModalOpen] = useState(false);
  const [pesapalTrackingId, setPesapalTrackingId] = useState('');
  const [isSuccessModalOpen, setIsSuccessModalOpen] = useState(false);
  const [completedOrder, setCompletedOrder] = useState<Order | null>(null);

  const handleAddToCart = useCallback(
    (product: Product, quantity = 1) => {
      setCart((prev) => {
        const existing = prev.find((item) => item.product.id === product.id);
        const available = product.stockQuantity - product.reservedQuantity;
        if (existing) {
          const newQty = Math.min(existing.quantity + quantity, available);
          return prev.map((item) =>
            item.product.id === product.id ? { ...item, quantity: newQty } : item,
          );
        }
        return [...prev, { product, quantity: Math.min(quantity, Math.max(1, available)) }];
      });
      addToast({
        type: 'success',
        title: 'Added to Cart',
        message: `${product.name} added to your checkout bag.`,
      });
    },
    [addToast],
  );

  const handleQuickBuy = useCallback(
    (product: Product) => {
      handleAddToCart(product, 1);
      setIsCartOpen(false);
      setIsCheckoutOpen(true);
    },
    [handleAddToCart],
  );

  const handleCheckoutSubmit = async (checkoutData: {
    customerName: string;
    customerEmail: string;
    customerPhone: string;
    buyerKraPin?: string;
    shippingAddress: {
      street: string;
      city: string;
      countyOrState: string;
      country: string;
    };
    paymentMethod: PaymentProvider;
  }) => {
    if (cart.length === 0) return;
    try {
      setIsCheckoutSubmitting(true);
      const order = await createOrderAction({
        customerName: checkoutData.customerName,
        customerEmail: checkoutData.customerEmail,
        customerPhone: checkoutData.customerPhone,
        buyerKraPin: checkoutData.buyerKraPin,
        shippingAddress: checkoutData.shippingAddress,
        items: cart.map((c) => ({ productId: c.product.id, quantity: c.quantity })),
        paymentMethod: checkoutData.paymentMethod,
      });
      setActiveOrder(order);
      setIsCheckoutOpen(false);

      if (checkoutData.paymentMethod === 'on_account') {
        addToast({
          type: 'success',
          title: 'Order placed on account',
          message: `${order.orderNumber} is an open invoice for ${checkoutData.customerName}.`,
        });
        setCart([]);
        return;
      }

      if (
        checkoutData.paymentMethod === 'mpesa_daraja' ||
        checkoutData.paymentMethod === 'kcb_buni'
      ) {
        const payRes = await initiateBranchPaymentAction({
          orderId: order.id,
          providerCode: checkoutData.paymentMethod,
        });
        if (payRes.status === 'failed') {
          throw new Error(payRes.errorMessage || 'Payment initiation failed');
        }
        setMpesaCheckoutRequestId(payRes.attemptId);
        setIsMpesaModalOpen(true);
        addToast({
          type: 'info',
          title: 'Payment prompt sent',
          message: payRes.customerMessage || `Complete payment on ${checkoutData.customerPhone}`,
        });
      } else if (checkoutData.paymentMethod === 'jenga_hq') {
        const payRes = await initiateBranchPaymentAction({
          orderId: order.id,
          providerCode: 'jenga_hq',
        });
        if (payRes.status === 'failed') {
          throw new Error(payRes.errorMessage || 'Jenga payment failed');
        }
        if (payRes.redirectUrl) {
          window.open(payRes.redirectUrl, '_blank', 'noopener,noreferrer');
        }
        setPesapalTrackingId(payRes.attemptId);
        setIsPesapalModalOpen(true);
        addToast({
          type: 'info',
          title: 'Jenga checkout started',
          message: payRes.customerMessage || 'Complete payment in the Jenga window',
        });
      } else {
        const payRes = await initiateBranchPaymentAction({
          orderId: order.id,
          providerCode: 'pesapal_v3',
        });
        if (payRes.status === 'failed') {
          throw new Error(payRes.errorMessage || 'Pesapal payment failed');
        }
        if (payRes.redirectUrl) {
          window.open(payRes.redirectUrl, '_blank', 'noopener,noreferrer');
        }
        setPesapalTrackingId(payRes.attemptId);
        setIsPesapalModalOpen(true);
        addToast({
          type: 'info',
          title: 'Pesapal checkout started',
          message: `Complete payment in the Pesapal window`,
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unable to place order';
      addToast({ type: 'error', title: 'Checkout Failed', message });
      throw err;
    } finally {
      setIsCheckoutSubmitting(false);
    }
  };

  const handlePaymentSuccess = (receipt: string) => {
    setIsMpesaModalOpen(false);
    setIsPesapalModalOpen(false);
    if (activeOrder) {
      setCompletedOrder({
        ...activeOrder,
        paymentStatus: 'reconciled',
        status: 'completed',
        mpesaReceiptNumber: receipt,
      });
      setIsSuccessModalOpen(true);
      setCart([]);
      refresh();
      addToast({
        type: 'success',
        title: 'Payment Successful',
        message: `Confirmed: ${receipt}`,
      });
    }
  };

  const handlePaymentFailed = (error: string) => {
    setIsMpesaModalOpen(false);
    setIsPesapalModalOpen(false);
    refresh();
    addToast({ type: 'error', title: 'Payment Declined', message: error });
  };

  const cartItemsCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-fg">
      <Toast toasts={toasts} onDismiss={removeToast} />
      <Navbar
        company={company}
        cartItemCount={cartItemsCount}
        onOpenCart={() => setIsCartOpen(true)}
        onOpenTrackOrder={() => setIsTrackOrderOpen(true)}
        onOpenHelp={() => setIsHelpOpen(true)}
        onOpenAccount={() => setIsAccountOpen(true)}
        activeCustomerName={sessionName || undefined}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedCategory={selectedCategory}
        onSelectCategory={setSelectedCategory}
      />

      <main className="storefront-shell flex-1 pt-4">
        <StorefrontView
          productsPromise={productsPromise}
          onSelectProduct={(p) => router.push(`/product/${p.id}`)}
          onAddToCart={(p) => handleAddToCart(p, 1)}
          onQuickBuy={handleQuickBuy}
          onRefresh={refresh}
          searchQuery={searchQuery}
          selectedCategory={selectedCategory}
          onSelectCategory={setSelectedCategory}
        />
      </main>

      <Footer
        company={company}
        onOpenTrackOrder={() => setIsTrackOrderOpen(true)}
        onOpenHelp={() => setIsHelpOpen(true)}
      />

      <CartDrawer
        isOpen={isCartOpen}
        onClose={() => setIsCartOpen(false)}
        items={cart}
        currency={currency}
        paymentLabels={paymentLabels}
        isSignedIn={Boolean(sessionName)}
        onUpdateQuantity={(productId, quantity) =>
          setCart((prev) =>
            prev.map((item) => (item.product.id === productId ? { ...item, quantity } : item)),
          )
        }
        onRemoveItem={(productId) =>
          setCart((prev) => prev.filter((item) => item.product.id !== productId))
        }
        onProceedToCheckout={() => {
          setIsCartOpen(false);
          setIsCheckoutOpen(true);
        }}
      />

      <CheckoutModal
        isOpen={isCheckoutOpen}
        onClose={() => setIsCheckoutOpen(false)}
        items={cart}
        currency={currency}
        defaultCountry={company.country}
        onSubmitCheckout={handleCheckoutSubmit}
        isLoading={isCheckoutSubmitting}
      />

      <MpesaStkModal
        isOpen={isMpesaModalOpen}
        onClose={() => setIsMpesaModalOpen(false)}
        order={activeOrder}
        checkoutRequestId={mpesaCheckoutRequestId}
        onPaymentSuccess={handlePaymentSuccess}
        onPaymentFailed={handlePaymentFailed}
      />

      <PesapalCheckoutModal
        isOpen={isPesapalModalOpen}
        onClose={() => setIsPesapalModalOpen(false)}
        order={activeOrder}
        orderTrackingId={pesapalTrackingId}
        onPaymentSuccess={handlePaymentSuccess}
        onPaymentFailed={handlePaymentFailed}
      />

      <OrderSuccessModal
        isOpen={isSuccessModalOpen}
        onClose={() => setIsSuccessModalOpen(false)}
        order={completedOrder}
        onContinueShopping={() => setIsSuccessModalOpen(false)}
      />

      <OrderTrackerModal
        isOpen={isTrackOrderOpen}
        onClose={() => setIsTrackOrderOpen(false)}
      />

      <CustomerHelpModal isOpen={isHelpOpen} onClose={() => setIsHelpOpen(false)} />

      <CustomerAccountModal
        isOpen={isAccountOpen}
        onClose={() => setIsAccountOpen(false)}
        onRefreshGlobalData={refresh}
      />
    </div>
  );
}

export function StorefrontPageClientBoundary(props: StorefrontPageClientProps) {
  return (
    <Suspense fallback={null}>
      <StorefrontPageClient {...props} />
    </Suspense>
  );
}
