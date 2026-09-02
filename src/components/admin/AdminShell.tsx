'use client';

import React, { useState, useCallback } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Menu, RefreshCw, Store } from 'lucide-react';
import { AdminSidebar } from './AdminSidebar';
import type { AdminTab } from './AdminView';
import { useRealtimeEvents } from '@/lib/realtime';

function pathToTab(pathname: string): AdminTab {
  if (pathname.startsWith('/admin/products')) return 'products';
  if (pathname.startsWith('/admin/categories')) return 'categories';
  if (pathname.startsWith('/admin/taxes')) return 'taxes';
  if (pathname.startsWith('/admin/currencies')) return 'currencies';
  if (pathname.startsWith('/admin/inventory')) return 'inventory';
  if (pathname.startsWith('/admin/orders')) return 'orders';
  if (pathname.startsWith('/admin/gateways')) return 'gateways';
  if (pathname.startsWith('/admin/reconciliation')) return 'reconciliation';
  if (pathname.startsWith('/admin/analytics')) return 'analytics';
  return 'dashboard';
}

const TITLES: Record<AdminTab, string> = {
  dashboard: 'Business Overview',
  products: 'Product Catalog',
  categories: 'Categories',
  taxes: 'Tax & Compliance',
  currencies: 'Currencies & FX',
  inventory: 'Stock & Warehouse',
  orders: 'Customer Orders',
  gateways: 'Payment Methods',
  reconciliation: 'Reconciliation',
  analytics: 'Customer Analytics',
};

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const activeTab = pathToTab(pathname);

  const onRefreshAll = useCallback(() => {
    router.refresh();
  }, [router]);

  const handleRealtime = useCallback(() => {
    router.refresh();
  }, [router]);

  const { isConnected } = useRealtimeEvents(handleRealtime);

  return (
    <div className="min-h-screen bg-black text-zinc-300 flex">
      <AdminSidebar
        isOpen={isMobileSidebarOpen}
        onClose={() => setIsMobileSidebarOpen(false)}
        onRefreshAll={onRefreshAll}
        isRealtimeConnected={isConnected}
      />

      <div className="flex-1 lg:pl-72 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 h-16 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur-md px-4 sm:px-6 flex items-center gap-3">
          <button
            type="button"
            className="lg:hidden p-2 rounded-lg text-zinc-400 hover:bg-zinc-900"
            onClick={() => setIsMobileSidebarOpen(true)}
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-semibold text-white truncate">{TITLES[activeTab]}</h1>
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Admin Console</p>
          </div>
          <button
            type="button"
            onClick={onRefreshAll}
            className="p-2 rounded-lg text-zinc-400 hover:bg-zinc-900 hover:text-white"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <Link
            href="/"
            className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:bg-zinc-900 hover:text-white"
          >
            <Store className="w-3.5 h-3.5" />
            Store
          </Link>
          <span
            className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-zinc-600'}`}
            title={isConnected ? 'Realtime connected' : 'Realtime offline'}
          />
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto space-y-6">
          {children}
        </main>
      </div>
    </div>
  );
}
