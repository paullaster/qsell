'use client';

import React from 'react';
import Link from 'next/link';
import { 
  ShoppingBag, 
  Search, 
  Truck, 
  HelpCircle, 
  User,
} from 'lucide-react';

interface NavbarProps {
  cartItemCount?: number;
  onOpenCart: () => void;
  onOpenTrackOrder: () => void;
  onOpenHelp: () => void;
  onOpenAccount?: () => void;
  activeCustomerName?: string;
  searchQuery?: string;
  onSearchChange?: (q: string) => void;
  onSelectCategory?: (category: string) => void;
  selectedCategory?: string;
}

export function Navbar({
  cartItemCount = 0,
  onOpenCart,
  onOpenTrackOrder,
  onOpenHelp,
  onOpenAccount,
  activeCustomerName = 'Paul Laster',
  searchQuery = '',
  onSearchChange,
  onSelectCategory,
  selectedCategory = 'All'
}: NavbarProps) {
  const categories = ['All', 'Electronics', 'Audio', 'Phones', 'Wearables', 'Drones & Cameras'];

  return (
    <header className="sticky top-0 z-40 w-full backdrop-blur-md bg-zinc-950/95 border-b border-zinc-800">
      {/* Main Nav Header */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="flex items-center gap-2.5 text-left group cursor-pointer focus:outline-none"
          >
            <div className="w-9 h-9 bg-indigo-600 rounded-lg flex items-center justify-center text-white font-bold text-lg shadow-md group-hover:bg-indigo-500 transition-colors">
              C
            </div>
            <div>
              <span className="text-base font-bold tracking-tight text-white flex items-center gap-1.5">
                CoreCommerce
              </span>
              <span className="block text-[10px] uppercase tracking-wider text-zinc-500 -mt-0.5">
                Hardware & Electronics
              </span>
            </div>
          </Link>
        </div>

        {/* Global Search Bar */}
        <div className="flex items-center flex-1 max-w-md mx-2 sm:mx-6">
          <div className="relative w-full">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <input
              type="text"
              placeholder="Search products, brands, or SKU..."
              value={searchQuery}
              onChange={(e) => onSearchChange?.(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-9 pr-8 py-2 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 transition-all"
            />
            {searchQuery && (
              <button
                onClick={() => onSearchChange?.('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-400 hover:text-white cursor-pointer"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Navigation Action Buttons */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Customer Account Trigger */}
          {onOpenAccount && (
            <button
              onClick={onOpenAccount}
              className="flex items-center gap-2 px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 hover:text-white text-xs font-medium transition-all cursor-pointer group"
              title="Manage Customer Account & Address Book"
            >
              <div className="w-5 h-5 rounded-full bg-indigo-600/30 text-indigo-400 flex items-center justify-center text-[10px] font-bold group-hover:bg-indigo-600 group-hover:text-white transition-colors">
                <User className="w-3 h-3" />
              </div>
              <span className="hidden md:inline max-w-[100px] truncate">{activeCustomerName || 'My Account'}</span>
            </button>
          )}

          {/* Track Order */}
          <button
            onClick={onOpenTrackOrder}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 hover:text-white text-xs font-medium transition-all cursor-pointer"
          >
            <Truck className="w-3.5 h-3.5 text-indigo-400" />
            <span className="hidden sm:inline">Track Order</span>
          </button>

          {/* Cart Trigger */}
          <button
            onClick={onOpenCart}
            className="relative flex items-center justify-center py-2 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/20 transition-all cursor-pointer group"
            aria-label="Shopping Cart"
          >
            <ShoppingBag className="w-4 h-4 group-hover:scale-105 transition-transform" />
            <span className="hidden sm:inline ml-2 text-xs font-semibold">Cart</span>
            {cartItemCount > 0 && (
              <span className="sm:ml-1.5 bg-white text-indigo-600 font-extrabold text-[10px] w-5 h-5 rounded-full flex items-center justify-center shadow">
                {cartItemCount}
              </span>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
