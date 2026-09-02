'use client';

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
  Coins
} from 'lucide-react';
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
} from '@/types/index';
import { AdminDashboard } from './AdminDashboard';
import { AdminProducts } from './AdminProducts';
import { AdminCategories } from './AdminCategories';
import { AdminTaxes } from './AdminTaxes';
import { AdminCurrencies } from './AdminCurrencies';
import { AdminInventory } from './AdminInventory';
import { AdminOrders } from './AdminOrders';
import { AdminPaymentConfig } from './AdminPaymentConfig';
import { AdminReconciliation } from './AdminReconciliation';
import { AdminAnalytics } from './AdminAnalytics';
import { AdminProductModal } from './AdminProductModal';
import { SkeletonMetrics, SkeletonTable } from '@/components/ui/Skeletons';

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
  | 'analytics';

interface AdminViewProps {
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
  onRefreshAll
}: AdminViewProps) {
  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard');
  const [isProductModalOpen, setIsProductModalOpen] = useState(false);
  const [productToEdit, setProductToEdit] = useState<Product | null>(null);

  // We can safely read categories & taxes via Suspense inside the modal or pass an empty fallback
  const [cachedCategories, setCachedCategories] = useState<Category[]>([]);
  const [cachedTaxes, setCachedTaxes] = useState<TaxCategory[]>([]);

  // When promises resolve, cache for the modal
  React.useEffect(() => {
    categoriesPromise.then(setCachedCategories).catch(() => {});
  }, [categoriesPromise]);

  React.useEffect(() => {
    taxesPromise.then(setCachedTaxes).catch(() => {});
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
    { id: 'analytics', label: 'Customer Accounts', icon: Users }
  ];

  return (
    <div className="space-y-6 pb-20">
      {/* Admin Navigation Ribbon */}
      <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4 p-2 bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 lg:pb-0 scrollbar-none">
          {tabs.map((t) => {
            const Icon = t.icon;
            const isActive = activeTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${
                  isActive
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-2 px-2">
          <button
            onClick={onRefreshAll}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-xs font-medium transition-colors cursor-pointer border border-zinc-700/50"
            title="Refresh all admin data"
          >
            <RefreshCw className="w-3.5 h-3.5" />
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
