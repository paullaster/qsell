import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { Navbar } from './components/layout/Navbar.js';
import { Footer } from './components/layout/Footer.js';
import { StorefrontView } from './components/store/StorefrontView.js';
import { AdminLayout, AdminTab } from './components/admin/AdminLayout.js';
import { ProductDetailModal } from './components/store/ProductDetailModal.js';
import { CartDrawer, CartItem } from './components/store/CartDrawer.js';
import { CheckoutModal } from './components/store/CheckoutModal.js';
import { MpesaStkModal } from './components/store/MpesaStkModal.js';
import { PesapalCheckoutModal } from './components/store/PesapalCheckoutModal.js';
import { OrderSuccessModal } from './components/store/OrderSuccessModal.js';
import { OrderTrackerModal } from './components/store/OrderTrackerModal.js';
import { CustomerHelpModal } from './components/store/CustomerHelpModal.js';
import { CustomerAccountModal } from './components/customer/CustomerAccountModal.js';
import { Toast, ToastNotification } from './components/ui/Toast.js';
import { useRealtimeEvents } from './lib/realtime.js';
import { 
  fetchProductsAction, 
  fetchCategoriesAction,
  fetchTaxCategoriesAction,
  fetchCurrenciesAction,
  fetchGatewaysAction, 
  fetchOrdersAction, 
  fetchTransactionsAction, 
  fetchReconciliationLogsAction, 
  fetchInventoryLedgerAction, 
  fetchAnalyticsAction, 
  fetchUserProfilesAction,
  createOrderAction,
  initiateDarajaStkAction,
  initiatePesapalPaymentAction
} from './lib/serverActions.js';
import { Product, Category, Order, PaymentProvider, TaxCategory, CurrencyConfig } from './types/index.js';

export default function App() {
  // --------------------------------------------------------------------------
  // URL Routing & Path Management
  // --------------------------------------------------------------------------
  const getInitialRoute = (): { view: 'store' | 'admin'; adminTab: AdminTab } => {
    if (typeof window === 'undefined') return { view: 'store', adminTab: 'dashboard' };
    const pathname = window.location.pathname.toLowerCase();
    if (pathname.startsWith('/admin')) {
      const parts = pathname.split('/').filter(Boolean);
      const tab = parts[1] as AdminTab;
      const validTabs: AdminTab[] = [
        'dashboard', 
        'products', 
        'categories', 
        'taxes', 
        'currencies', 
        'inventory', 
        'orders', 
        'gateways', 
        'reconciliation', 
        'analytics'
      ];
      return {
        view: 'admin',
        adminTab: validTabs.includes(tab) ? tab : 'dashboard'
      };
    }
    return { view: 'store', adminTab: 'dashboard' };
  };

  const [currentView, setCurrentView] = useState<'store' | 'admin'>(() => getInitialRoute().view);
  const [adminActiveTab, setAdminActiveTab] = useState<AdminTab>(() => getInitialRoute().adminTab);

  // Listen for browser navigation (Back / Forward / direct URL navigation)
  useEffect(() => {
    const handlePopState = () => {
      const route = getInitialRoute();
      setCurrentView(route.view);
      setAdminActiveTab(route.adminTab);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Admin Tab selection with URL synchronization
  const handleAdminSelectTab = useCallback((tab: AdminTab) => {
    setAdminActiveTab(tab);
    const path = tab === 'dashboard' ? '/admin' : `/admin/${tab}`;
    window.history.pushState(null, '', path);
  }, []);

  // Navigate to customer storefront
  const handleNavigateToStore = useCallback(() => {
    setCurrentView('store');
    window.history.pushState(null, '', '/');
  }, []);

  // --------------------------------------------------------------------------
  // Data Promises (for React 19 Suspense boundaries)
  // --------------------------------------------------------------------------
  const [dataVersion, setDataVersion] = useState<number>(1);

  const productsPromise = useMemo(() => fetchProductsAction(), [dataVersion]);
  const categoriesPromise = useMemo(() => fetchCategoriesAction(), [dataVersion]);
  const taxesPromise = useMemo(() => fetchTaxCategoriesAction(), [dataVersion]);
  const currenciesPromise = useMemo(() => fetchCurrenciesAction(), [dataVersion]);
  const gatewaysPromise = useMemo(() => fetchGatewaysAction(), [dataVersion]);
  const ordersPromise = useMemo(() => fetchOrdersAction(), [dataVersion]);
  const transactionsPromise = useMemo(() => fetchTransactionsAction(), [dataVersion]);
  const reconciliationLogsPromise = useMemo(() => fetchReconciliationLogsAction(), [dataVersion]);
  const inventoryLedgerPromise = useMemo(() => fetchInventoryLedgerAction(), [dataVersion]);
  const analyticsPromise = useMemo(() => fetchAnalyticsAction(), [dataVersion]);
  const userProfilesPromise = useMemo(() => fetchUserProfilesAction(), [dataVersion]);

  const refreshAllData = useCallback(() => {
    setDataVersion((v) => v + 1);
  }, []);

  // --------------------------------------------------------------------------
  // Toast Notifications
  // --------------------------------------------------------------------------
  const [toasts, setToasts] = useState<ToastNotification[]>([]);

  const addToast = useCallback((toast: Omit<ToastNotification, 'id'>) => {
    const newId = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev, { ...toast, id: newId }]);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // --------------------------------------------------------------------------
  // Real-Time Server-Sent Events (SSE)
  // --------------------------------------------------------------------------
  const handleRealtimeEvent = useCallback((event: any) => {
    if (event.type === 'inventory_updated') {
      refreshAllData();
      if (currentView === 'admin') {
        addToast({
          type: 'info',
          title: 'Stock Updated',
          message: `${event.data.productName}: Live inventory is now ${event.data.newStock}`
        });
      }
    } else if (event.type === 'order_created') {
      refreshAllData();
      if (currentView === 'admin') {
        addToast({
          type: 'info',
          title: 'New Order Received',
          message: `Order #${event.data.orderNumber} created for KES ${event.data.totalAmount?.toLocaleString()}`
        });
      }
    } else if (event.type === 'payment_received') {
      refreshAllData();
      if (currentView === 'admin') {
        addToast({
          type: 'success',
          title: 'Payment Reconciled',
          message: `KES ${event.data.amount?.toLocaleString()} confirmed via ${event.data.provider}`
        });
      }
    } else if (event.type === 'reconciliation_completed') {
      refreshAllData();
      if (currentView === 'admin') {
        addToast({
          type: 'success',
          title: 'Auto-Reconciliation Event',
          message: `Order #${event.data.orderNumber} ledger match confirmed with zero discrepancy`
        });
      }
    }
  }, [refreshAllData, addToast, currentView]);

  const { isConnected: isSseConnected } = useRealtimeEvents(handleRealtimeEvent);

  // --------------------------------------------------------------------------
  // Cart State (Customer Local Persistence)
  // --------------------------------------------------------------------------
  const [cart, setCart] = useState<CartItem[]>(() => {
    try {
      const saved = localStorage.getItem('omnicommerce_cart');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('omnicommerce_cart', JSON.stringify(cart));
    } catch (e) {
      console.error(e);
    }
  }, [cart]);

  const handleAddToCart = useCallback((product: Product, quantity = 1) => {
    setCart((prev) => {
      const existing = prev.find((item) => item.product.id === product.id);
      const available = product.stockQuantity - product.reservedQuantity;
      if (existing) {
        const newQty = Math.min(existing.quantity + quantity, available);
        return prev.map((item) =>
          item.product.id === product.id ? { ...item, quantity: newQty } : item
        );
      } else {
        return [...prev, { product, quantity: Math.min(quantity, Math.max(1, available)) }];
      }
    });

    addToast({
      type: 'success',
      title: 'Added to Cart',
      message: `${product.name} added to your checkout bag.`
    });
  }, [addToast]);

  const handleUpdateCartQuantity = useCallback((productId: string, quantity: number) => {
    setCart((prev) =>
      prev.map((item) =>
        item.product.id === productId ? { ...item, quantity } : item
      )
    );
  }, []);

  const handleRemoveCartItem = useCallback((productId: string) => {
    setCart((prev) => prev.filter((item) => item.product.id !== productId));
  }, []);

  // --------------------------------------------------------------------------
  // Modals & Navigation State
  // --------------------------------------------------------------------------
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [isCheckoutSubmitting, setIsCheckoutSubmitting] = useState(false);
  const [isTrackOrderOpen, setIsTrackOrderOpen] = useState(false);
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');

  // M-Pesa STK Prompt Modal
  const [isMpesaModalOpen, setIsMpesaModalOpen] = useState(false);
  const [activeOrder, setActiveOrder] = useState<Order | null>(null);
  const [mpesaCheckoutRequestId, setMpesaCheckoutRequestId] = useState<string>('');

  // Pesapal Modal
  const [isPesapalModalOpen, setIsPesapalModalOpen] = useState(false);
  const [pesapalTrackingId, setPesapalTrackingId] = useState<string>('');

  // Success Modal
  const [isSuccessModalOpen, setIsSuccessModalOpen] = useState(false);
  const [completedOrder, setCompletedOrder] = useState<Order | null>(null);

  // Quick Buy
  const handleQuickBuy = useCallback((product: Product) => {
    handleAddToCart(product, 1);
    setIsCartOpen(false);
    setIsCheckoutOpen(true);
  }, [handleAddToCart]);

  // Checkout Submission
  const handleCheckoutSubmit = async (checkoutData: {
    customerName: string;
    customerEmail: string;
    customerPhone: string;
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

      const items = cart.map((c) => ({
        productId: c.product.id,
        quantity: c.quantity
      }));

      // Create order with ACID stock reservation in PostgreSQL
      const order = await createOrderAction({
        customerName: checkoutData.customerName,
        customerEmail: checkoutData.customerEmail,
        customerPhone: checkoutData.customerPhone,
        shippingAddress: checkoutData.shippingAddress,
        items,
        paymentMethod: checkoutData.paymentMethod
      });

      setActiveOrder(order);
      setIsCheckoutOpen(false);

      // Initiate payment rail
      if (checkoutData.paymentMethod === 'mpesa_daraja') {
        const stkRes = await initiateDarajaStkAction(order.id, checkoutData.customerPhone);
        setMpesaCheckoutRequestId(stkRes.checkoutRequestId);
        setIsMpesaModalOpen(true);
        addToast({
          type: 'info',
          title: 'M-Pesa STK Push Sent',
          message: `Safaricom prompt dispatched to ${checkoutData.customerPhone}`
        });
      } else {
        const pesapalRes = await initiatePesapalPaymentAction(order.id);
        setPesapalTrackingId(pesapalRes.orderTrackingId);
        setIsPesapalModalOpen(true);
        addToast({
          type: 'info',
          title: 'Pesapal Gateway Initialized',
          message: `Pesapal v3.0 Order Reference: ${pesapalRes.merchantReference}`
        });
      }
    } catch (err: any) {
      addToast({
        type: 'error',
        title: 'Checkout Failed',
        message: err.message || 'Unable to place order'
      });
      throw err;
    } finally {
      setIsCheckoutSubmitting(false);
    }
  };

  // Payment Result Handlers
  const handlePaymentSuccess = (receipt: string) => {
    setIsMpesaModalOpen(false);
    setIsPesapalModalOpen(false);

    if (activeOrder) {
      const updated: Order = {
        ...activeOrder,
        paymentStatus: 'reconciled',
        status: 'confirmed',
        mpesaReceiptNumber: receipt
      };
      setCompletedOrder(updated);
      setIsSuccessModalOpen(true);
      setCart([]); // Clear cart
      refreshAllData();
      addToast({
        type: 'success',
        title: 'Payment Successful',
        message: `M-Pesa / Pesapal confirmed: ${receipt}`
      });
    }
  };

  const handlePaymentFailed = (error: string) => {
    setIsMpesaModalOpen(false);
    setIsPesapalModalOpen(false);
    refreshAllData();
    addToast({
      type: 'error',
      title: 'Payment Declined',
      message: error
    });
  };

  const cartItemsCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  // --------------------------------------------------------------------------
  // Render Admin View vs Storefront View
  // --------------------------------------------------------------------------
  if (currentView === 'admin') {
    return (
      <div className="min-h-screen bg-black text-zinc-300 font-sans selection:bg-indigo-600 selection:text-white">
        <Toast toasts={toasts} onDismiss={removeToast} />
        <AdminLayout
          activeTab={adminActiveTab}
          onSelectTab={handleAdminSelectTab}
          analyticsPromise={analyticsPromise}
          productsPromise={productsPromise}
          categoriesPromise={categoriesPromise}
          taxesPromise={taxesPromise}
          currenciesPromise={currenciesPromise}
          gatewaysPromise={gatewaysPromise}
          ordersPromise={ordersPromise}
          transactionsPromise={transactionsPromise}
          reconciliationLogsPromise={reconciliationLogsPromise}
          inventoryLedgerPromise={inventoryLedgerPromise}
          userProfilesPromise={userProfilesPromise}
          onRefreshAll={refreshAllData}
          isRealtimeConnected={isSseConnected}
          onNavigateToStore={handleNavigateToStore}
        />
      </div>
    );
  }

  // Pure Customer Storefront Experience
  return (
    <div className="min-h-screen bg-black text-zinc-300 flex flex-col font-sans selection:bg-indigo-600 selection:text-white">
      {/* Toast Manager */}
      <Toast toasts={toasts} onDismiss={removeToast} />

      {/* Customer Storefront Navbar */}
      <Navbar
        cartItemCount={cartItemsCount}
        onOpenCart={() => setIsCartOpen(true)}
        onOpenTrackOrder={() => setIsTrackOrderOpen(true)}
        onOpenHelp={() => setIsHelpOpen(true)}
        onOpenAccount={() => setIsAccountOpen(true)}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedCategory={selectedCategory}
        onSelectCategory={setSelectedCategory}
      />

      {/* Main Storefront Body */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-4">
        <StorefrontView
          productsPromise={productsPromise}
          onSelectProduct={(p) => setSelectedProduct(p)}
          onAddToCart={(p) => handleAddToCart(p, 1)}
          onQuickBuy={handleQuickBuy}
          onRefresh={refreshAllData}
          searchQuery={searchQuery}
          selectedCategory={selectedCategory}
        />
      </main>

      {/* Customer Storefront Footer */}
      <Footer 
        onOpenTrackOrder={() => setIsTrackOrderOpen(true)}
        onOpenHelp={() => setIsHelpOpen(true)}
      />

      {/* Cart Drawer */}
      <CartDrawer
        isOpen={isCartOpen}
        onClose={() => setIsCartOpen(false)}
        items={cart}
        onUpdateQuantity={handleUpdateCartQuantity}
        onRemoveItem={handleRemoveCartItem}
        onProceedToCheckout={() => {
          setIsCartOpen(false);
          setIsCheckoutOpen(true);
        }}
      />

      {/* Product Detail Modal */}
      <ProductDetailModal
        product={selectedProduct}
        onClose={() => setSelectedProduct(null)}
        onAddToCart={(p, qty) => handleAddToCart(p, qty)}
        onQuickBuy={(p) => {
          setSelectedProduct(null);
          handleQuickBuy(p);
        }}
      />

      {/* Checkout Modal */}
      <CheckoutModal
        isOpen={isCheckoutOpen}
        onClose={() => setIsCheckoutOpen(false)}
        items={cart}
        onSubmitCheckout={handleCheckoutSubmit}
        isLoading={isCheckoutSubmitting}
      />

      {/* M-Pesa STK Prompt Simulator Modal */}
      <MpesaStkModal
        isOpen={isMpesaModalOpen}
        onClose={() => setIsMpesaModalOpen(false)}
        order={activeOrder}
        checkoutRequestId={mpesaCheckoutRequestId}
        onPaymentSuccess={handlePaymentSuccess}
        onPaymentFailed={handlePaymentFailed}
      />

      {/* Pesapal Modal */}
      <PesapalCheckoutModal
        isOpen={isPesapalModalOpen}
        onClose={() => setIsPesapalModalOpen(false)}
        order={activeOrder}
        orderTrackingId={pesapalTrackingId}
        onPaymentSuccess={handlePaymentSuccess}
        onPaymentFailed={handlePaymentFailed}
      />

      {/* Order Success Receipt Modal */}
      <OrderSuccessModal
        isOpen={isSuccessModalOpen}
        onClose={() => setIsSuccessModalOpen(false)}
        order={completedOrder}
        onContinueShopping={() => {
          setIsSuccessModalOpen(false);
        }}
      />

      {/* Customer Order Tracker Modal */}
      <OrderTrackerModal
        isOpen={isTrackOrderOpen}
        onClose={() => setIsTrackOrderOpen(false)}
        ordersPromise={ordersPromise}
      />

      {/* Customer Help & FAQs Modal */}
      <CustomerHelpModal
        isOpen={isHelpOpen}
        onClose={() => setIsHelpOpen(false)}
      />
    </div>
  );
}
