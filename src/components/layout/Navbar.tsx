'use client';

import { Suspense, useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ChevronDown,
  HelpCircle,
  Heart,
  LogOut,
  MapPin,
  Search,
  ShoppingBag,
  Truck,
  User,
} from 'lucide-react';
import { CompanyBrand } from '@/components/ui/CompanyBrand';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { useCompanyUiConfig } from '@/components/company/CompanyUiConfigProvider';
import { hasSupportContent } from '@/config/company-ui';
import { logoutAction } from '@/server/domains/auth/actions';
import { useStore } from '@/components/store/StoreContext';
import { useCart } from '@/components/store/cart/CartProvider';
import { useWishlist } from '@/components/store/wishlist/WishlistProvider';
import { useDismiss } from '@/components/ui/useDismiss';
import { CategoryMenu } from './CategoryMenu';
import { StoreSearch } from './StoreSearch';

export function Navbar() {
  const { company, categories, sessionName: activeCustomerName, openCart, openTrackOrder, openHelp } = useStore();
  const { count: cartItemCount } = useCart();
  const wishlist = useWishlist();
  const { support } = useCompanyUiConfig();
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const closeAccountMenu = useCallback(() => setIsAccountMenuOpen(false), []);
  useDismiss(isAccountMenuOpen, accountMenuRef, closeAccountMenu);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-line bg-surface/95 backdrop-blur-md">
      <div className="storefront-shell flex min-h-16 flex-wrap items-center gap-x-2 gap-y-2 py-2 sm:flex-nowrap sm:gap-4 sm:py-0">
        <div className="order-1 max-w-[42vw] min-w-0 shrink sm:max-w-56 sm:flex-none">
          <Link
            href="/"
            aria-label="Home"
            className="group block min-w-0 cursor-pointer rounded-lg text-left focus-visible:outline-2 focus-visible:outline-indigo-500"
          >
            <CompanyBrand
              tradingName={company.tradingName}
              tagline={company.tagline}
              logoUrl={company.logoUrl}
              accentColor={company.accentColor}
            />
          </Link>
        </div>

        <div className="order-3 flex basis-full items-center gap-2 sm:order-2 sm:mx-2 sm:max-w-xl sm:min-w-0 sm:flex-1 lg:mx-6">
          <CategoryMenu categories={categories} />
          <Suspense fallback={<div className="h-11 w-full rounded-xl border border-line bg-surface-raised" />}>
            <StoreSearch />
          </Suspense>
        </div>

        <div className="order-2 ml-auto flex shrink-0 items-center gap-1 sm:order-3 sm:gap-2">
          <div className="hidden sm:block">
            <ThemeToggle />
          </div>
          <div ref={accountMenuRef} className="relative">
            <button
              type="button"
              aria-label={
                activeCustomerName ? `Account menu for ${activeCustomerName}` : 'Account menu'
              }
              aria-haspopup="menu"
              aria-expanded={isAccountMenuOpen}
              aria-controls="storefront-account-menu"
              onClick={() => setIsAccountMenuOpen((open) => !open)}
              className="flex h-10 w-10 cursor-pointer touch-manipulation items-center justify-center gap-1 rounded-xl border border-line bg-surface-raised text-fg transition-colors hover:border-line-strong hover:bg-hover sm:w-auto sm:px-3"
            >
              <User className="h-4 w-4 shrink-0 text-indigo-500" />
              <span className="hidden max-w-28 truncate text-xs font-medium md:inline">
                {activeCustomerName || 'Account'}
              </span>
              <ChevronDown
                className={`hidden h-3.5 w-3.5 transition-transform sm:block ${isAccountMenuOpen ? 'rotate-180' : ''}`}
              />
            </button>
            {isAccountMenuOpen ? (
              <div
                id="storefront-account-menu"
                role="menu"
                aria-label="Account"
                className="absolute right-0 z-50 mt-2 w-56 rounded-xl border border-line bg-surface-raised p-1 shadow-xl"
              >
                {activeCustomerName ? (
                  <>
                    <Link
                      href="/profile"
                      role="menuitem"
                      onClick={() => setIsAccountMenuOpen(false)}
                      className="flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg hover:bg-hover"
                    >
                      <User className="h-4 w-4" /> My Profile
                    </Link>
                    <Link
                      href="/profile/addresses"
                      role="menuitem"
                      onClick={() => setIsAccountMenuOpen(false)}
                      className="flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg hover:bg-hover"
                    >
                      <MapPin className="h-4 w-4" /> Addresses
                    </Link>
                    <Link
                      href="/profile/orders"
                      role="menuitem"
                      onClick={() => setIsAccountMenuOpen(false)}
                      className="flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg hover:bg-hover"
                    >
                      <Truck className="h-4 w-4" /> My Orders
                    </Link>
                    <hr className="my-1 border-line" />
                    <form action={logoutAction}>
                      <input type="hidden" name="returnTo" value="/" />
                      <button
                        type="submit"
                        role="menuitem"
                        className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                      >
                        <LogOut className="h-4 w-4" /> Logout
                      </button>
                    </form>
                  </>
                ) : (
                  <Link
                    href="/login"
                    role="menuitem"
                    onClick={() => setIsAccountMenuOpen(false)}
                    className="flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg hover:bg-hover"
                  >
                    <User className="h-4 w-4" /> Sign in
                  </Link>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsAccountMenuOpen(false);
                    openTrackOrder();
                  }}
                  className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-fg hover:bg-hover"
                >
                  <Truck className="h-4 w-4" /> Track order
                </button>
                {hasSupportContent(support) ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsAccountMenuOpen(false);
                      openHelp();
                    }}
                    className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-fg hover:bg-hover"
                  >
                    <HelpCircle className="h-4 w-4" /> {support.name}
                  </button>
                ) : null}
                <div className="flex min-h-12 items-center justify-between border-t border-line px-3 py-1 sm:hidden">
                  <span className="text-sm text-fg">Appearance</span>
                  <ThemeToggle />
                </div>
              </div>
            ) : null}
          </div>

          <button
            type="button"
            onClick={openTrackOrder}
            aria-label="Track order"
            title="Track order"
            className="hidden h-10 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-line bg-surface-raised px-3 text-fg transition-all hover:border-line-strong hover:text-fg-strong lg:flex"
          >
            <Truck className="h-3.5 w-3.5 text-indigo-400" />
            <span className="hidden text-xs lg:inline">Track Order</span>
          </button>

          <Link
            href="/wishlist"
            aria-label={wishlist.ids.length === 0 ? 'Saved products' : `Saved products, ${String(wishlist.ids.length)}`}
            title="Saved products"
            className="relative flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl border border-line bg-surface-raised text-fg transition-colors hover:border-line-strong hover:bg-hover"
          >
            <Heart className="h-4 w-4 text-rose-500" aria-hidden="true" />
            {wishlist.ids.length > 0 ? <span aria-hidden="true" className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-xs font-bold text-white">{wishlist.ids.length}</span> : null}
          </Link>

          <button
            type="button"
            onClick={openCart}
            className="group relative flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl bg-indigo-600 text-white shadow-md shadow-indigo-600/20 transition-all hover:bg-indigo-500 sm:w-auto sm:px-3.5"
            aria-label="Shopping Cart"
          >
            <ShoppingBag className="h-4 w-4 transition-transform group-hover:scale-105" />
            <span className="ml-2 hidden text-xs font-semibold sm:inline">Cart</span>
            {cartItemCount > 0 && (
              <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-white px-1 text-xs font-extrabold text-indigo-600 shadow sm:static sm:ml-1.5 sm:h-5 sm:w-5 sm:px-0">
                {cartItemCount}
              </span>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
