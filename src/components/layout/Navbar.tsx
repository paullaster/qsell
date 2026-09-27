'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ChevronDown,
  CreditCard,
  HelpCircle,
  LogOut,
  MapPin,
  Search,
  ShoppingBag,
  Truck,
  User,
} from 'lucide-react';
import { CompanyBrand } from '@/components/ui/CompanyBrand';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { logoutAction } from '@/server/domains/auth/actions';
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
  onOpenHelp,
  onOpenAccount,
  activeCustomerName,
  searchQuery = '',
  onSearchChange,
}: NavbarProps) {
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isAccountMenuOpen) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const root = accountMenuRef.current;
      if (root && !root.contains(event.target as Node)) {
        setIsAccountMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsAccountMenuOpen(false);
    };

    // pointerdown covers mouse, pen, and real touchscreen taps. Use capture so
    // the menu closes even if the outside target stops bubbling click events.
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isAccountMenuOpen]);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-line bg-surface/95 backdrop-blur-md">
      <div className="storefront-shell flex min-h-16 flex-wrap items-center gap-x-2 gap-y-2 py-2 sm:flex-nowrap sm:gap-4 sm:py-0">
        <div className="order-1 min-w-0 max-w-[42vw] shrink sm:max-w-56 sm:flex-none">
          <Link href="/" className="group block min-w-0 cursor-pointer text-left focus:outline-none">
            <CompanyBrand
              tradingName={company.tradingName}
              tagline={company.tagline}
              logoUrl={company.logoUrl}
              accentColor={company.accentColor}
            />
          </Link>
        </div>

        <div className="order-3 basis-full sm:order-2 sm:mx-2 sm:flex sm:min-w-0 sm:max-w-md sm:flex-1 sm:items-center lg:mx-6">
          <div className="relative w-full">
            <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle sm:left-3.5" />
            <input
              type="text"
              placeholder="Search products, brands, or SKU..."
              value={searchQuery}
              onChange={(e) => onSearchChange?.(e.target.value)}
              aria-label="Search products, brands, or SKU"
              className="h-10 w-full rounded-xl border border-line bg-surface-raised py-2 pr-9 pl-9 text-sm text-fg-strong placeholder-fg-subtle transition-all focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 focus:outline-none sm:h-9 sm:pl-10 sm:text-xs"
            />
            {searchQuery && (
              <button
                onClick={() => onSearchChange?.('')}
                className="absolute top-1/2 right-3 -translate-y-1/2 cursor-pointer text-xs text-fg-muted hover:text-fg-strong"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="order-2 ml-auto flex shrink-0 items-center gap-1 sm:order-3 sm:gap-2">
          <div className="hidden sm:block">
            <ThemeToggle />
          </div>
          <div ref={accountMenuRef} className="relative">
            <button
              type="button"
              aria-label={activeCustomerName ? `Account menu for ${activeCustomerName}` : 'Account menu'}
              aria-haspopup="menu"
              aria-expanded={isAccountMenuOpen}
              aria-controls="storefront-account-menu"
              onClick={() => setIsAccountMenuOpen((open) => !open)}
              className="flex h-10 w-10 touch-manipulation cursor-pointer items-center justify-center gap-1 rounded-xl border border-line bg-surface-raised text-fg transition-colors hover:border-line-strong hover:bg-hover sm:w-auto sm:px-3"
            >
              <User className="h-4 w-4 shrink-0 text-indigo-500" />
              <span className="hidden max-w-28 truncate text-xs font-medium md:inline">
                {activeCustomerName || 'Account'}
              </span>
              <ChevronDown className={`hidden h-3.5 w-3.5 transition-transform sm:block ${isAccountMenuOpen ? 'rotate-180' : ''}`} />
            </button>
            {isAccountMenuOpen ? (
            <div id="storefront-account-menu" role="menu" aria-label="Account" className="absolute right-0 z-50 mt-2 w-56 rounded-xl border border-line bg-surface-raised p-1 shadow-xl">
              {activeCustomerName ? (
                <>
                  <Link href="/profile" role="menuitem" onClick={() => setIsAccountMenuOpen(false)} className="flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg hover:bg-hover">
                    <User className="h-4 w-4" /> My Profile
                  </Link>
                  {onOpenAccount ? (
                    <button type="button" role="menuitem" onClick={() => { setIsAccountMenuOpen(false); onOpenAccount(); }} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-fg hover:bg-hover">
                      <User className="h-4 w-4" /> Account overview
                    </button>
                  ) : null}
                  <Link href="/profile/addresses" role="menuitem" onClick={() => setIsAccountMenuOpen(false)} className="flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg hover:bg-hover">
                    <MapPin className="h-4 w-4" /> Addresses
                  </Link>
                  <Link href="/profile/orders" role="menuitem" onClick={() => setIsAccountMenuOpen(false)} className="flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg hover:bg-hover">
                    <Truck className="h-4 w-4" /> My Orders
                  </Link>
                  <Link href="/profile/payment" role="menuitem" onClick={() => setIsAccountMenuOpen(false)} className="flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg hover:bg-hover">
                    <CreditCard className="h-4 w-4" /> Payment Methods
                  </Link>
                  <hr className="my-1 border-line" />
                  <form action={logoutAction}>
                    <button type="submit" role="menuitem" className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30">
                      <LogOut className="h-4 w-4" /> Logout
                    </button>
                  </form>
                </>
              ) : (
                <Link href="/login" role="menuitem" onClick={() => setIsAccountMenuOpen(false)} className="flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg hover:bg-hover">
                  <User className="h-4 w-4" /> Sign in
                </Link>
              )}
              <button type="button" role="menuitem" onClick={() => { setIsAccountMenuOpen(false); onOpenTrackOrder(); }} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-fg hover:bg-hover">
                <Truck className="h-4 w-4" /> Track order
              </button>
              <button type="button" role="menuitem" onClick={() => { setIsAccountMenuOpen(false); onOpenHelp(); }} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-fg hover:bg-hover">
                <HelpCircle className="h-4 w-4" /> Help & support
              </button>
              <div className="flex min-h-12 items-center justify-between border-t border-line px-3 py-1 sm:hidden">
                <span className="text-sm text-fg">Appearance</span>
                <ThemeToggle />
              </div>
            </div>
            ) : null}
          </div>

          <button
            type="button"
            onClick={onOpenTrackOrder}
            aria-label="Track order"
            title="Track order"
            className="hidden h-10 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-line bg-surface-raised px-3 text-fg transition-all hover:border-line-strong hover:text-fg-strong lg:flex"
          >
            <Truck className="h-3.5 w-3.5 text-indigo-400" />
            <span className="hidden text-xs lg:inline">Track Order</span>
          </button>

          <button
            type="button"
            onClick={onOpenCart}
            className="group relative flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl bg-indigo-600 text-white shadow-md shadow-indigo-600/20 transition-all hover:bg-indigo-500 sm:w-auto sm:px-3.5"
            aria-label="Shopping Cart"
          >
            <ShoppingBag className="h-4 w-4 transition-transform group-hover:scale-105" />
            <span className="ml-2 hidden text-xs font-semibold sm:inline">Cart</span>
            {cartItemCount > 0 && (
              <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-white px-1 text-[10px] font-extrabold text-indigo-600 shadow sm:static sm:ml-1.5 sm:h-5 sm:w-5 sm:px-0">
                {cartItemCount}
              </span>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
