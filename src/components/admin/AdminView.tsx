'use client';

import type { ordersPageAction } from '@/server/domains/orders/actions';
import React, { Suspense, useState, use } from 'react';
import {
  LayoutDashboard,
  Package,
  FolderTree,
  Layers,
  CreditCard,
  ShieldCheck,
  ShoppingBag,
  Users,
  RefreshCw,
  Percent,
  Coins,
} from 'lucide-react';
import {
  type Product,
  type Category,
  type TaxCategory,
  type CurrencyConfig,
  type PaymentGatewayConfig,
  type Order,
  type TransactionRecord,
  type ReconciliationLog,
  type DashboardAnalytics,
  type InventoryLedgerEntry,
  type UserProfile,
} from '@/types/index';
import { AdminDashboard } from './AdminDashboard';
import { AdminProducts } from './AdminProducts';
import { AdminCategories } from './AdminCategories';
import { AdminCurrencies } from './AdminCurrencies';
import { AdminInventory } from './AdminInventory';
import { AdminOrders } from './AdminOrders';
import { AdminPaymentConfig } from './AdminPaymentConfig';
import { AdminReconciliation } from './AdminReconciliation';
import { AdminAnalytics } from './AdminAnalytics';
import { AdminProductModal } from './AdminProductModal';
import { SkeletonMetrics, SkeletonTable } from '@/components/ui/Skeletons';
import { getCompanySettingsAction } from '@/server/domains/company/actions';

export type AdminTab =
  | 'dashboard'
  | 'products'
  | 'categories'
  | 'taxes'
  | 'currencies'
  | 'inventory'
  | 'orders'
  | 'gateways'
  | 'reconciliation'
  | 'analytics'
  | 'company';

interface AdminViewProps {
  analyticsPromise: Promise<DashboardAnalytics>;
  productsPromise: Promise<Product[]>;
  categoriesPromise: Promise<Category[]>;
  taxesPromise: Promise<TaxCategory[]>;
  currenciesPromise: Promise<CurrencyConfig[]>;
  gatewaysPromise: Promise<PaymentGatewayConfig[]>;
  ordersPromise: ReturnType<typeof ordersPageAction>;
  transactionsPromise: Promise<TransactionRecord[]>;
  reconciliationLogsPromise: Promise<ReconciliationLog[]>;
  inventoryLedgerPromise: Promise<InventoryLedgerEntry[]>;
  userProfilesPromise: Promise<UserProfile[]>;
  onRefreshAll: () => void;
}

export function AdminView({
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
}: AdminViewProps) {
  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard');
  const [isProductModalOpen, setIsProductModalOpen] = useState(false);
  const [productToEdit, setProductToEdit] = useState<Product | null>(null);
  const [productToDuplicate, setProductToDuplicate] = useState<Product | null>(null);
  const [companyPromise] = useState(() => getCompanySettingsAction());

  // We can safely read categories & taxes via Suspense inside the modal or pass an empty fallback
  const [cachedCategories, setCachedCategories] = useState<Category[]>([]);
  const [cachedTaxes, setCachedTaxes] = useState<TaxCategory[]>([]);

  // When promises resolve, cache for the modal
  React.useEffect(() => {
    void Promise.resolve(categoriesPromise)
      .then(setCachedCategories)
      .catch(() => {});
  }, [categoriesPromise]);

  React.useEffect(() => {
    void Promise.resolve(taxesPromise)
      .then(setCachedTaxes)
      .catch(() => {});
  }, [taxesPromise]);

  const tabs: { id: AdminTab; label: string; icon: any }[] = [
    { id: 'dashboard', label: 'Business Overview', icon: LayoutDashboard },
    { id: 'orders', label: 'Customer Orders', icon: ShoppingBag },
    { id: 'inventory', label: 'Stock & Warehouse', icon: Layers },
    { id: 'products', label: 'Product Catalog', icon: Package },
    { id: 'categories', label: 'Categories & Departments', icon: FolderTree },
    { id: 'taxes', label: 'Tax & Compliance', icon: Percent },
    { id: 'currencies', label: 'Currencies & FX', icon: Coins },
    { id: 'reconciliation', label: 'Payment Reconciliation', icon: ShieldCheck },
    { id: 'gateways', label: 'Payment Methods', icon: CreditCard },
    { id: 'analytics', label: 'Customer Accounts', icon: Users },
  ];

  return (
    <div className="space-y-6 pb-20">
      {/* Admin Navigation Ribbon */}
      <div className="flex flex-col items-stretch justify-between gap-4 rounded-xl border border-line bg-surface-raised p-2 shadow-xl lg:flex-row lg:items-center">
        <div className="flex scrollbar-none items-center gap-1.5 overflow-x-auto pb-1 lg:pb-0">
          {tabs.map((t) => {
            const Icon = t.icon;
            const isActive = activeTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`flex cursor-pointer items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold whitespace-nowrap transition-all ${
                  isActive
                    ? 'TW bg-indigo-600 shadow-lg shadow-indigo-600/20'
                    : 'hover:TW text-fg-muted hover:bg-hover'
                }`}
              >
                <Icon className="h-4 w-4" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-2 px-2">
          <button
            onClick={onRefreshAll}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line-strong/50 bg-surface-sunken px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-hover hover:text-fg-strong"
            title="Refresh all admin data"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Sync Data</span>
          </button>
        </div>
      </div>

      {/* Tab Panels with Suspense */}
      {activeTab === 'dashboard' && (
        <Suspense fallback={<SkeletonMetrics />}>
          <AdminDashboard
            analyticsPromise={analyticsPromise}
            onNavigateTab={(tab) => setActiveTab(tab)}
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
              setProductToDuplicate(null);
              setIsProductModalOpen(true);
            }}
            onEditProduct={(p) => {
              setProductToEdit(p);
              setProductToDuplicate(null);
              setIsProductModalOpen(true);
            }}
            onDuplicateProduct={(p) => {
              setProductToEdit(null);
              setProductToDuplicate(p);
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

      {activeTab === 'currencies' && (
        <Suspense fallback={<SkeletonTable />}>
          <AdminCurrencies currenciesPromise={currenciesPromise} onRefreshAll={onRefreshAll} />
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
          <AdminOrders firstPage={ordersPromise} companyPromise={companyPromise} />
        </Suspense>
      )}

      {activeTab === 'gateways' && (
        <Suspense fallback={<SkeletonTable />}>
          <AdminPaymentConfig gatewaysPromise={gatewaysPromise} onRefresh={onRefreshAll} />
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

      {/* Add / Edit Product Modal */}
      <AdminProductModal
        isOpen={isProductModalOpen}
        onClose={() => setIsProductModalOpen(false)}
        productToEdit={productToEdit}
        duplicateFrom={productToDuplicate}
        categories={cachedCategories}
        itemTypes={[]}
        taxCategories={cachedTaxes}
        onSuccess={() => {
          onRefreshAll();
        }}
      />
    </div>
  );
}
