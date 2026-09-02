import React from 'react';
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
  ExternalLink,
  Percent,
  Coins
} from 'lucide-react';
import { AdminTab } from './AdminView.js';

interface AdminSidebarProps {
  activeTab: AdminTab;
  onSelectTab: (tab: AdminTab) => void;
  isOpen: boolean;
  onClose: () => void;
  onRefreshAll: () => void;
  isRealtimeConnected: boolean;
  onNavigateToStore: () => void;
}

export function AdminSidebar({
  activeTab,
  onSelectTab,
  isOpen,
  onClose,
  onRefreshAll,
  onNavigateToStore
}: AdminSidebarProps) {
  const navSections: {
    heading: string;
    items: {
      id: AdminTab;
      label: string;
      icon: any;
    }[];
  }[] = [
    {
      heading: 'Sales & Inventory',
      items: [
        { id: 'orders', label: 'Customer Orders', icon: ShoppingBag },
        { id: 'inventory', label: 'Stock & Warehouse', icon: Layers },
        { id: 'products', label: 'Product Catalog', icon: Package },
        { id: 'categories', label: 'Categories & Departments', icon: FolderTree }
      ]
    },
    {
      heading: 'Finance, Tax & Global FX',
      items: [
        { id: 'dashboard', label: 'Business Overview', icon: LayoutDashboard },
        { id: 'taxes', label: 'Tax & Compliance', icon: Percent },
        { id: 'currencies', label: 'Currencies & FX Rates', icon: Coins },
        { id: 'reconciliation', label: 'Payment Reconciliation', icon: ShieldCheck },
        { id: 'gateways', label: 'Payment Methods', icon: CreditCard },
        { id: 'analytics', label: 'Customer Accounts', icon: Users }
      ]
    }
  ];

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpen && (
        <div 
          className="fixed inset-0 z-40 bg-black/80 backdrop-blur-sm lg:hidden transition-opacity"
          onClick={onClose}
        />
      )}

      {/* Sidebar Container */}
      <aside
        className={`fixed top-0 bottom-0 left-0 z-50 w-72 bg-zinc-950 border-r border-zinc-800 flex flex-col transition-transform duration-300 ease-in-out lg:translate-x-0 ${
          isOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white font-bold shadow-lg shadow-indigo-600/20 text-xs">
              OC
            </div>
            <div>
              <span className="font-bold text-sm text-white tracking-tight block">OmniCommerce</span>
              <span className="text-[10px] text-zinc-500 block">Administration Control</span>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white bg-zinc-900 border border-zinc-800 lg:hidden cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Administrator Profile */}
        <div className="p-3.5 m-3 rounded-xl bg-zinc-900 border border-zinc-800/90 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-bold text-xs">
              P
            </div>
            <div>
              <span className="font-semibold text-xs text-white block">Paul Laster Okoth</span>
              <span className="text-[10px] text-zinc-400 block">Admin Workspace</span>
            </div>
          </div>
          <button
            onClick={onRefreshAll}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
            title="Refresh All Store Data"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Navigation Sections */}
        <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-5 scrollbar-none">
          {navSections.map((sec, i) => (
            <div key={i} className="space-y-1">
              <span className="px-3 text-[10px] font-bold uppercase tracking-widest text-zinc-400 block">
                {sec.heading}
              </span>
              <div className="space-y-0.5 pt-1">
                {sec.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => {
                        onSelectTab(item.id);
                        onClose();
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-all cursor-pointer group ${
                        isActive
                          ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 font-semibold'
                          : 'text-zinc-400 hover:text-white hover:bg-zinc-900'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <Icon className={`w-4 h-4 transition-transform group-hover:scale-105 ${isActive ? 'text-white' : 'text-zinc-400 group-hover:text-white'}`} />
                        <span>{item.label}</span>
                      </div>
                      <ChevronRight className={`w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity ${isActive ? 'opacity-100' : ''}`} />
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Sidebar Footer Controls */}
        <div className="p-3 border-t border-zinc-800 space-y-2 bg-zinc-950">
          <button
            onClick={onNavigateToStore}
            className="w-full py-2.5 px-3 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-zinc-300 hover:text-white text-xs font-semibold flex items-center justify-center gap-2 transition-all cursor-pointer group"
          >
            <Store className="w-3.5 h-3.5 text-indigo-400 group-hover:scale-105 transition-transform" />
            <span>Switch to Customer Store</span>
            <ExternalLink className="w-3 h-3 text-zinc-500 ml-auto" />
          </button>
        </div>
      </aside>
    </>
  );
}
