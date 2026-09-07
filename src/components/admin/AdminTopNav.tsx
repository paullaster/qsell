'use client';

import React from 'react';
import { Menu, RefreshCw, Store, ExternalLink } from 'lucide-react';
import { type AdminTab } from './AdminView';

interface AdminTopNavProps {
  activeTab: AdminTab;
  onOpenMobileSidebar: () => void;
  onRefreshAll: () => void;
  onNavigateToStore: () => void;
  isRealtimeConnected: boolean;
}

export function AdminTopNav({
  activeTab,
  onOpenMobileSidebar,
  onRefreshAll,
  onNavigateToStore,
}: AdminTopNavProps) {
  const tabTitles: Record<AdminTab, { title: string; subtitle: string }> = {
    dashboard: {
      title: 'Business Overview & Sales Performance',
      subtitle: 'Real-time sales revenue, customer order volume, and payment collections',
    },
    products: {
      title: 'Product Catalog & Pricing',
      subtitle: 'Manage items, cost prices, retail selling prices, and gross margins',
    },
    categories: {
      title: 'Categories & Departments',
      subtitle: 'Organize your store catalog into easy-to-browse shopping departments',
    },
    taxes: {
      title: 'Tax Rates & Fiscal Compliance',
      subtitle:
        'Configure dynamic VAT, sales taxes, and duty schedules with live inclusive and exclusive calculators',
    },
    currencies: {
      title: 'Multi-Market Currency & Global FX Rates',
      subtitle:
        'Manage cross-border currencies, exchange rate multipliers, and international pricing matrices',
    },
    inventory: {
      title: 'Stock Control & Warehouse Management',
      subtitle: 'Receive supplier goods (PO), write off damaged stock, and conduct physical audits',
    },
    orders: {
      title: 'Customer Orders & Shipments',
      subtitle: 'Process orders, track courier dispatches, and print warehouse packing slips',
    },
    gateways: {
      title: 'Payment Methods & Settings',
      subtitle: 'Configure M-Pesa (Till/Paybill) and Card payment options for customer checkout',
    },
    reconciliation: {
      title: 'Payment Reconciliation & Settlement',
      subtitle:
        'Match received customer payments against sales orders to verify bank and mobile money deposits',
    },
    analytics: {
      title: 'Customer Accounts & Sales Insights',
      subtitle: 'Track customer buying patterns, repeat purchase rates, and customer accounts',
    },
    company: {
      title: 'Company Setup',
      subtitle: 'Legal identity, branding, storefront UI, and module names',
    },
  };

  const currentInfo = tabTitles[activeTab] || tabTitles.dashboard;

  return (
    <header className="sticky top-0 z-30 w-full border-b border-zinc-800 bg-zinc-950/90 px-4 py-3.5 backdrop-blur-md sm:px-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        {/* Left: Mobile Menu Trigger + Breadcrumb */}
        <div className="flex items-center gap-3">
          <button
            onClick={onOpenMobileSidebar}
            className="cursor-pointer rounded-lg border border-zinc-800 bg-zinc-900 p-2 text-zinc-400 hover:text-white lg:hidden"
            aria-label="Open Admin Menu"
          >
            <Menu className="h-5 w-5" />
          </button>

          <div>
            <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-400">
              <span>Admin Workspace</span>
              <span>/</span>
              <span className="font-semibold text-indigo-400 uppercase">{activeTab}</span>
            </div>
            <h1 className="text-base leading-tight font-bold tracking-tight text-white sm:text-lg">
              {currentInfo.title}
            </h1>
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2.5 self-end sm:self-center">
          {/* Refresh Action */}
          <button
            onClick={onRefreshAll}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
            title="Refresh records"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Sync</span>
          </button>

          {/* Quick Exit to Store */}
          <button
            onClick={onNavigateToStore}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-600/10 px-3 py-1.5 text-xs font-semibold text-indigo-300 transition-colors hover:bg-indigo-600/20"
          >
            <Store className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Storefront</span>
            <ExternalLink className="h-3 w-3 text-indigo-400" />
          </button>
        </div>
      </div>
    </header>
  );
}
