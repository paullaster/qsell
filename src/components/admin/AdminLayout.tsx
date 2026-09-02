import React, { Suspense, useState, useEffect } from 'react';
import { 
  Product, 
  Category,
  TaxCategory,
  CurrencyConfig,
  PaymentGatewayConfig, 
  Order, 
  TransactionRecord, 
  ReconciliationLog, 
  DashboardAnalytics, 
  InventoryLedgerEntry, 
  UserProfile 
} from '../../types/index.js';
import { AdminSidebar } from './AdminSidebar.js';
import { AdminTopNav } from './AdminTopNav.js';
import { AdminDashboard } from './AdminDashboard.js';
import { AdminProducts } from './AdminProducts.js';
import { AdminCategories } from './AdminCategories.js';
import { AdminTaxes } from './AdminTaxes.js';
import { AdminCurrencies } from './AdminCurrencies.js';
import { AdminInventory } from './AdminInventory.js';
import { AdminOrders } from './AdminOrders.js';
import { AdminPaymentConfig } from './AdminPaymentConfig.js';
import { AdminReconciliation } from './AdminReconciliation.js';
import { AdminAnalytics } from './AdminAnalytics.js';
import { AdminProductModal } from './AdminProductModal.js';
import { SkeletonMetrics, SkeletonTable } from '../ui/Skeletons.js';
import { AdminTab } from './AdminView.js';

export type { AdminTab };

interface AdminLayoutProps {
  activeTab: AdminTab;
  onSelectTab: (tab: AdminTab) => void;
  analyticsPromise: Promise<DashboardAnalytics>;
  productsPromise: Promise<Product[]>;
  categoriesPromise: Promise<Category[]>;
  taxesPromise: Promise<TaxCategory[]>;
  currenciesPromise: Promise<CurrencyConfig[]>;
  gatewaysPromise: Promise<PaymentGatewayConfig[]>;
  ordersPromise: Promise<Order[]>;
  transactionsPromise: Promise<TransactionRecord[]>;
  reconciliationLogsPromise: Promise<ReconciliationLog[]>;
  inventoryLedgerPromise: Promise<InventoryLedgerEntry[]>;
  userProfilesPromise: Promise<UserProfile[]>;
  onRefreshAll: () => void;
  isRealtimeConnected: boolean;
  onNavigateToStore: () => void;
}

export function AdminLayout({
  activeTab,
  onSelectTab,
  analyticsPromise,
  productsPromise,
  categoriesPromise,
  taxesPromise,
  currenciesPromise,
  gatewaysPromise,
  ordersPromise,
  transactionsPromise,
  reconciliationLogsPromise,
  inventoryLedgerPromise,
  userProfilesPromise,
  onRefreshAll,
  isRealtimeConnected,
  onNavigateToStore
}: AdminLayoutProps) {
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isProductModalOpen, setIsProductModalOpen] = useState(false);
  const [productToEdit, setProductToEdit] = useState<Product | null>(null);

  const [cachedCategories, setCachedCategories] = useState<Category[]>([]);
  const [cachedTaxes, setCachedTaxes] = useState<TaxCategory[]>([]);

  useEffect(() => {
    categoriesPromise.then(setCachedCategories).catch(() => {});
  }, [categoriesPromise]);

  useEffect(() => {
    taxesPromise.then(setCachedTaxes).catch(() => {});
  }, [taxesPromise]);

  return (
    <div className="min-h-screen bg-black text-zinc-300 flex">
      {/* Left Sidebar */}
      <AdminSidebar
        activeTab={activeTab}
        onSelectTab={onSelectTab}
        isOpen={isMobileSidebarOpen}
        onClose={() => setIsMobileSidebarOpen(false)}
        onRefreshAll={onRefreshAll}
        isRealtimeConnected={isRealtimeConnected}
        onNavigateToStore={onNavigateToStore}
      />

      {/* Main Admin Viewport */}
      <div className="flex-1 lg:pl-72 flex flex-col min-w-0">
        {/* Admin Top Navigation */}
        <AdminTopNav
          activeTab={activeTab}
          onOpenMobileSidebar={() => setIsMobileSidebarOpen(true)}
          onRefreshAll={onRefreshAll}
          onNavigateToStore={onNavigateToStore}
          isRealtimeConnected={isRealtimeConnected}
        />

        {/* Content Body */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto space-y-6">
          {activeTab === 'dashboard' && (
            <Suspense fallback={<SkeletonMetrics />}>
              <AdminDashboard
                analyticsPromise={analyticsPromise}
                onNavigateTab={(tab) => onSelectTab(tab)}
              />
            </Suspense>
          )}

          {activeTab === 'products' && (
            <Suspense fallback={<SkeletonTable />}>
              <AdminProducts
                productsPromise={productsPromise}
                categoriesPromise={categoriesPromise}
                onOpenCreateProduct={() => {
                  setProductToEdit(null);
                  setIsProductModalOpen(true);
                }}
                onEditProduct={(p) => {
                  setProductToEdit(p);
                  setIsProductModalOpen(true);
                }}
                onRefresh={onRefreshAll}
              />
            </Suspense>
          )}

          {activeTab === 'categories' && (
            <Suspense fallback={<SkeletonTable />}>
              <AdminCategories
                categoriesPromise={categoriesPromise}
                productsPromise={productsPromise}
                onRefresh={onRefreshAll}
              />
            </Suspense>
          )}

          {activeTab === 'taxes' && (
            <Suspense fallback={<SkeletonTable />}>
              <AdminTaxes
                taxesPromise={taxesPromise}
                onRefreshAll={onRefreshAll}
              />
            </Suspense>
          )}

          {activeTab === 'currencies' && (
            <Suspense fallback={<SkeletonTable />}>
              <AdminCurrencies
                currenciesPromise={currenciesPromise}
                onRefreshAll={onRefreshAll}
              />
            </Suspense>
          )}

          {activeTab === 'inventory' && (
            <Suspense fallback={<SkeletonTable />}>
              <AdminInventory
                productsPromise={productsPromise}
                ledgerPromise={inventoryLedgerPromise}
                onRefresh={onRefreshAll}
              />
            </Suspense>
          )}

          {activeTab === 'orders' && (
            <Suspense fallback={<SkeletonTable />}>
              <AdminOrders
                ordersPromise={ordersPromise}
                onRefresh={onRefreshAll}
              />
            </Suspense>
          )}

          {activeTab === 'gateways' && (
            <Suspense fallback={<SkeletonTable />}>
              <AdminPaymentConfig
                gatewaysPromise={gatewaysPromise}
                onRefresh={onRefreshAll}
              />
            </Suspense>
          )}

          {activeTab === 'reconciliation' && (
            <Suspense fallback={<SkeletonTable />}>
              <AdminReconciliation
                reconciliationLogsPromise={reconciliationLogsPromise}
                onRefresh={onRefreshAll}
              />
            </Suspense>
          )}

          {activeTab === 'analytics' && (
            <Suspense fallback={<SkeletonTable />}>
              <AdminAnalytics
                analyticsPromise={analyticsPromise}
                userProfilesPromise={userProfilesPromise}
              />
            </Suspense>
          )}
        </main>
      </div>

      {/* Add / Edit Product Modal */}
      <AdminProductModal
        isOpen={isProductModalOpen}
        onClose={() => setIsProductModalOpen(false)}
        productToEdit={productToEdit}
        categories={cachedCategories}
        taxCategories={cachedTaxes}
        onSuccess={() => {
          onRefreshAll();
        }}
      />
    </div>
  );
}
