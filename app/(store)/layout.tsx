import type { ReactNode } from 'react';
import { StoreShell } from '@/components/store/StoreShell';
import { storefrontSeo } from '@/server/domains/storefront/seo';
import { organizationJsonLd, websiteJsonLd } from '@/lib/seo/jsonld';
import { jsonLdText } from '@/lib/product-seo';
import { resolveCompanyLogoUrl } from '@/lib/companyLogo';
import { paymentMethodLabels, shopCategories, shopCurrency, signedInName } from '@/server/domains/storefront/shell';

/**
 * The shop's frame: header, footer, cart and the panels that open from them. Its few small reads run side by side and are
 * awaited here on purpose: the page below may answer "not found" or redirect, and the response status can only be set
 * before the first byte is sent. The page's own slow parts still stream behind their own loading states.
 */
export default async function StoreLayout({ children }: { children: ReactNode }) {
  const [{ company, ui, base }, currency, paymentLabels, categories, sessionName] = await Promise.all([
    storefrontSeo(),
    shopCurrency(),
    paymentMethodLabels(),
    shopCategories(),
    signedInName(),
  ]);
  const logo = resolveCompanyLogoUrl(company.logoUrl);
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(organizationJsonLd(company, ui.support, base, logo)) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(websiteJsonLd(company, base)) }} />
      <StoreShell company={company} currency={currency} paymentLabels={paymentLabels} categories={categories} sessionName={sessionName} year={new Date().getFullYear()}>
        {children}
      </StoreShell>
    </>
  );
}
