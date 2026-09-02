'use client';

import React from 'react';
import Link from 'next/link';
import { ShoppingBag, Search, Truck, User } from 'lucide-react';
import { CompanyBrand } from '@/components/ui/CompanyBrand';
import type { CompanySettingsRow } from '@/server/db/drizzle/schema';

interface NavbarProps {
  company: Pick<CompanySettingsRow, 'tradingName' | 'tagline' | 'logoUrl' | 'accentColor'>;
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
  company,
  cartItemCount = 0,
  onOpenCart,
  onOpenTrackOrder,
  onOpenAccount,
  activeCustomerName = 'Paul Laster',
  searchQuery = '',
  onSearchChange,
}: NavbarProps) {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-zinc-800 bg-zinc-950/95 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <Link href="/" className="group cursor-pointer text-left focus:outline-none">
            <CompanyBrand
              tradingName={company.tradingName}
              tagline={company.tagline}
              logoUrl={company.logoUrl}
              accentColor={company.accentColor}
            />
          </Link>
        </div>

        <div className="mx-2 flex max-w-md flex-1 items-center sm:mx-6">
          <div className="relative w-full">
            <Search className="absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              placeholder="Search products, brands, or SKU..."
              value={searchQuery}
              onChange={(e) => onSearchChange?.(e.target.value)}
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900 py-2 pr-8 pl-9 text-xs text-white placeholder-zinc-500 transition-all focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 focus:outline-none"
            />
            {searchQuery && (
              <button
                onClick={() => onSearchChange?.('')}
                className="absolute top-1/2 right-3 -translate-y-1/2 cursor-pointer text-xs text-zinc-400 hover:text-white"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {onOpenAccount && (
            <button
              onClick={onOpenAccount}
              className="group flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-300 transition-all hover:border-zinc-700 hover:text-white"
              title="Manage Customer Account & Address Book"
            >
              <div className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600/30 text-[10px] font-bold text-indigo-400 transition-colors group-hover:bg-indigo-600 group-hover:text-white">
                <User className="h-3 w-3" />
              </div>
              <span className="hidden max-w-[100px] truncate md:inline">
                {activeCustomerName || 'My Account'}
              </span>
            </button>
          )}

          <button
            onClick={onOpenTrackOrder}
            className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-300 transition-all hover:border-zinc-700 hover:text-white"
          >
            <Truck className="h-3.5 w-3.5 text-indigo-400" />
            <span className="hidden sm:inline">Track Order</span>
          </button>

          <button
            onClick={onOpenCart}
            className="group relative flex cursor-pointer items-center justify-center rounded-xl bg-indigo-600 px-3.5 py-2 text-white shadow-md shadow-indigo-600/20 transition-all hover:bg-indigo-500"
            aria-label="Shopping Cart"
          >
            <ShoppingBag className="h-4 w-4 transition-transform group-hover:scale-105" />
            <span className="ml-2 hidden text-xs font-semibold sm:inline">Cart</span>
            {cartItemCount > 0 && (
              <span className="ml-0 flex h-5 w-5 items-center justify-center rounded-full bg-white text-[10px] font-extrabold text-indigo-600 shadow sm:ml-1.5">
                {cartItemCount}
              </span>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
