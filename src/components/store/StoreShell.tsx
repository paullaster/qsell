'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Navbar } from '@/components/layout/Navbar';
import { Footer } from '@/components/layout/Footer';
import { CartDrawer } from '@/components/store/CartDrawer';
import { OrderTrackerModal } from '@/components/store/OrderTrackerModal';
import { CustomerHelpModal } from '@/components/store/CustomerHelpModal';
import { CartProvider } from '@/components/store/cart/CartProvider';
import { WishlistProvider } from '@/components/store/wishlist/WishlistProvider';
import { StoreContextProvider, moneyFormatter, type StoreContextValue } from '@/components/store/StoreContext';
import { ToastProvider } from '@/components/store/ToastProvider';
import { useRealtimeEvents } from '@/lib/realtime';
import type { CurrencyConfig } from '@/types/index';
import type { PublicCompany } from '@/lib/company-view';
import type { StorefrontCategory } from '@/lib/storefront-search';

export interface StoreShellProps {
  company: PublicCompany;
  currency: CurrencyConfig | null;
  paymentLabels: string[];
  categories: StorefrontCategory[];
  sessionName: string | null;
  /** The year for the copyright line, from the server. */
  year: number;
  children: ReactNode;
}

/** The shop's frame. What it shows is read in parallel on the server before the page starts, so a page can still answer 404 or redirect with the right status. */
export function StoreShell({ children, year, company, currency, paymentLabels, categories, sessionName }: StoreShellProps) {
  const router = useRouter();
  const [panel, setPanel] = useState<'cart' | 'track' | 'help' | null>(null);
  const openCart = useCallback(() => setPanel('cart'), []);
  const closeCart = useCallback(() => setPanel(null), []);
  const openTrackOrder = useCallback(() => setPanel('track'), []);
  const openHelp = useCallback(() => setPanel('help'), []);

  // Stock changes elsewhere refresh what is on screen, but a burst of changes is one refresh.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useRealtimeEvents(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => router.refresh(), 2000);
  });
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const value = useMemo<StoreContextValue>(
    () => ({ company, currency, paymentLabels, categories, sessionName, year, money: moneyFormatter(currency), openCart, closeCart, openTrackOrder, openHelp }),
    [company, currency, paymentLabels, categories, sessionName, year, openCart, closeCart, openTrackOrder, openHelp],
  );

  return (
    <StoreContextProvider value={value}>
      <ToastProvider>
        <CartProvider>
          <WishlistProvider>
          <div className="flex min-h-dvh flex-col bg-canvas text-fg">
            <a
              href="#main-content"
              className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-lg focus:bg-indigo-600 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
            >
              Skip to content
            </a>
            <Navbar />
            <main id="main-content" className="storefront-shell flex-1 pt-4">
              {children}
            </main>
            <Footer />
            <CartDrawer isOpen={panel === 'cart'} onClose={closeCart} />
            <OrderTrackerModal isOpen={panel === 'track'} onClose={closeCart} />
            <CustomerHelpModal isOpen={panel === 'help'} onClose={closeCart} />
          </div>
          </WishlistProvider>
        </CartProvider>
      </ToastProvider>
    </StoreContextProvider>
  );
}
