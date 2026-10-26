'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { CurrencyConfig } from '@/types/index';
import type { PublicCompany } from '@/lib/company-view';
import type { StorefrontCategory } from '@/lib/storefront-search';
import { formatCartAmount } from '@/lib/cartMoney';

/** What every part of the shop needs to know and can ask for: who runs it, how money is shown, which panels to open. */
export interface StoreContextValue {
  company: PublicCompany;
  currency: CurrencyConfig | null;
  paymentLabels: string[];
  categories: StorefrontCategory[];
  /** The signed-in shopper's name (or email), or null for a guest. */
  sessionName: string | null;
  /** The year for the copyright line, read once on the server so the page and the browser agree. */
  year: number;
  money: (amount: number) => string;
  openCart: () => void;
  closeCart: () => void;
  openTrackOrder: () => void;
  openHelp: () => void;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function StoreContextProvider({ value, children }: { value: StoreContextValue; children: ReactNode }) {
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreContextValue {
  const value = useContext(StoreContext);
  if (value === null) throw new Error('useStore must be used inside the shop layout.');
  return value;
}

export const moneyFormatter = (currency: CurrencyConfig | null) => (amount: number) => formatCartAmount(amount, currency);
