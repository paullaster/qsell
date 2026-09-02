'use client';

import React from 'react';
import { 
  Menu, 
  RefreshCw, 
  Store, 
  ExternalLink
} from 'lucide-react';
import { AdminTab } from './AdminView';

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
  onNavigateToStore
}: AdminTopNavProps) {
  const tabTitles: Record<AdminTab, { title: string; subtitle: string }> = {
    dashboard: { 
      title: 'Business Overview & Sales Performance', 
      subtitle: 'Real-time sales revenue, customer order volume, and payment collections' 
    },
    products: {
      title: 'Product Catalog & Pricing',
      subtitle: 'Manage items, cost prices, retail selling prices, and gross margins'
    },
    categories: {
      title: 'Categories & Departments',
      subtitle: 'Organize your store catalog into easy-to-browse shopping departments'
    },
    taxes: {
      title: 'Tax Rates & Fiscal Compliance',
      subtitle: 'Configure dynamic VAT, sales taxes, and duty schedules with live inclusive and exclusive calculators'
    },
    currencies: {
      title: 'Multi-Market Currency & Global FX Rates',
      subtitle: 'Manage cross-border currencies, exchange rate multipliers, and international pricing matrices'
    },
    inventory: { 
      title: 'Stock Control & Warehouse Management', 
      subtitle: 'Receive supplier goods (PO), write off damaged stock, and conduct physical audits' 
    },
    orders: { 
      title: 'Customer Orders & Shipments', 
      subtitle: 'Process orders, track courier dispatches, and print warehouse packing slips' 
    },
    gateways: { 
      title: 'Payment Methods & Settings', 
      subtitle: 'Configure M-Pesa (Till/Paybill) and Card payment options for customer checkout' 
    },
    reconciliation: { 
      title: 'Payment Reconciliation & Settlement', 
      subtitle: 'Match received customer payments against sales orders to verify bank and mobile money deposits' 
    },
    analytics: { 
      title: 'Customer Accounts & Sales Insights', 
      subtitle: 'Track customer buying patterns, repeat purchase rates, and customer accounts' 
    }
  };

  const currentInfo = tabTitles[activeTab] || tabTitles.dashboard;

  return (
    <header className="sticky top-0 z-30 w-full bg-zinc-950/90 backdrop-blur-md border-b border-zinc-800 px-4 sm:px-6 py-3.5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        {/* Left: Mobile Menu Trigger + Breadcrumb */}
        <div className="flex items-center gap-3">
          <button
            onClick={onOpenMobileSidebar}
            className="p-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white lg:hidden cursor-pointer"
            aria-label="Open Admin Menu"
          >
            <Menu className="w-5 h-5" />
          </button>

          <div>
            <div className="flex items-center gap-2 text-[11px] font-mono text-zinc-400">
              <span>Admin Workspace</span>
              <span>/</span>
              <span className="text-indigo-400 font-semibold uppercase">{activeTab}</span>
            </div>
            <h1 className="text-base sm:text-lg font-bold text-white tracking-tight leading-tight">
              {currentInfo.title}
            </h1>
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2.5 self-end sm:self-center">
          {/* Refresh Action */}
          <button
            onClick={onRefreshAll}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-800 transition-colors cursor-pointer text-xs"
            title="Refresh records"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Sync</span>
          </button>

          {/* Quick Exit to Store */}
          <button
            onClick={onNavigateToStore}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600/10 hover:bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 text-xs font-semibold transition-colors cursor-pointer"
          >
            <Store className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Storefront</span>
            <ExternalLink className="w-3 h-3 text-indigo-400" />
          </button>
        </div>
      </div>
    </header>
  );
}
