import type { ReactNode } from 'react';
import { getCompanySettingsAction } from '@/server/domains/company/actions';
import { StoreShell } from '@/components/store/StoreShell';
import { paymentMethodLabels, shopCategories, shopCurrency, signedInName } from '@/server/domains/storefront/shell';

/**
 * The shop's frame: header, footer, cart and the panels that open from them. Its few small reads run side by side and are
 * awaited here on purpose: the page below may answer "not found" or redirect, and the response status can only be set
 * before the first byte is sent. The page's own slow parts still stream behind their own loading states.
 */
export default async function StoreLayout({ children }: { children: ReactNode }) {
  const [company, currency, paymentLabels, categories, sessionName] = await Promise.all([
    getCompanySettingsAction(),
    shopCurrency(),
    paymentMethodLabels(),
    shopCategories(),
    signedInName(),
  ]);
  return (
    <StoreShell company={company} currency={currency} paymentLabels={paymentLabels} categories={categories} sessionName={sessionName} year={new Date().getFullYear()}>
      {children}
    </StoreShell>
  );
}
