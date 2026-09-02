'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  Package,
  FolderTree,
  Layers,
  CreditCard,
  ShieldCheck,
  ShoppingBag,
  Users,
  Store,
  RefreshCw,
  ChevronRight,
  X,
  Percent,
  Coins,
} from 'lucide-react';
import type { AdminTab } from './AdminView';

const TAB_PATHS: Record<AdminTab, string> = {
  dashboard: '/admin',
  products: '/admin/products',
  categories: '/admin/categories',
  taxes: '/admin/taxes',
  currencies: '/admin/currencies',
  inventory: '/admin/inventory',
  orders: '/admin/orders',
  gateways: '/admin/gateways',
  reconciliation: '/admin/reconciliation',
  analytics: '/admin/analytics',
};

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

interface AdminSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  onRefreshAll: () => void;
  isRealtimeConnected: boolean;
}

export function AdminSidebar({
  isOpen,
  onClose,
  onRefreshAll,
  isRealtimeConnected,
}: AdminSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const activeTab = pathToTab(pathname);

  const navSections: {
    heading: string;
    items: { id: AdminTab; label: string; icon: React.ElementType }[];
  }[] = [
    {
      heading: 'Sales & Inventory',
      items: [
        { id: 'orders', label: 'Customer Orders', icon: ShoppingBag },
        { id: 'inventory', label: 'Stock & Warehouse', icon: Layers },
        { id: 'products', label: 'Product Catalog', icon: Package },
        { id: 'categories', label: 'Categories & Departments', icon: FolderTree },
      ],
    },
    {
      heading: 'Finance, Tax & Global FX',
      items: [
        { id: 'dashboard', label: 'Business Overview', icon: LayoutDashboard },
        { id: 'taxes', label: 'Tax & Compliance', icon: Percent },
        { id: 'currencies', label: 'Currencies & FX Rates', icon: Coins },
        { id: 'reconciliation', label: 'Payment Reconciliation', icon: ShieldCheck },
        { id: 'gateways', label: 'Payment Methods', icon: CreditCard },
        { id: 'analytics', label: 'Customer Accounts', icon: Users },
      ],
    },
  ];

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/80 backdrop-blur-sm lg:hidden transition-opacity"
          onClick={onClose}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 w-72 bg-zinc-950 border-r border-zinc-800 flex flex-col transform transition-transform duration-200 lg:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="h-16 px-5 flex items-center justify-between border-b border-zinc-800">
          <Link href="/admin" className="flex items-center gap-2.5" onClick={onClose}>
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white font-bold text-sm">
              C
            </div>
            <div>
              <p className="text-sm font-bold text-white leading-none">OmniCommerce</p>
              <p className="text-[10px] uppercase tracking-wider text-zinc-500 mt-0.5">Admin Console</p>
            </div>
          </Link>
          <button type="button" className="lg:hidden text-zinc-400" onClick={onClose}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-6">
          {navSections.map((section) => (
            <div key={section.heading}>
              <p className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                {section.heading}
              </p>
              <ul className="space-y-0.5">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const active = activeTab === item.id;
                  return (
                    <li key={item.id}>
                      <Link
                        href={TAB_PATHS[item.id]}
                        onClick={onClose}
                        className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                          active
                            ? 'bg-indigo-600/15 text-indigo-300'
                            : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                        }`}
                      >
                        <Icon className="w-4 h-4 shrink-0" />
                        <span className="flex-1 truncate">{item.label}</span>
                        {active && <ChevronRight className="w-3.5 h-3.5 opacity-60" />}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="p-3 border-t border-zinc-800 space-y-2">
          <button
            type="button"
            onClick={() => {
              onRefreshAll();
              router.refresh();
            }}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-400 hover:bg-zinc-900 hover:text-white"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh data
            <span
              className={`ml-auto w-2 h-2 rounded-full ${
                isRealtimeConnected ? 'bg-emerald-500' : 'bg-zinc-600'
              }`}
            />
          </button>
          <Link
            href="/"
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-400 hover:bg-zinc-900 hover:text-white"
          >
            <Store className="w-4 h-4" />
            Back to storefront
          </Link>
        </div>
      </aside>
    </>
  );
}
