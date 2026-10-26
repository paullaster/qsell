import type { MetadataRoute } from 'next';
import { StorefrontCatalog } from '@/server/domains/catalog/storefront-service';
import { getCompanyUiConfigAction } from '@/server/domains/company/actions';
import { siteBaseUrl } from '@/server/domains/storefront/site';
import { absoluteUrl } from '@/lib/product-seo';
import { policyAddress } from '@/config/company-ui';
import { productHref } from '@/lib/product-link';
import { storefrontHref } from '@/lib/storefront-search';

// Built from the live catalog on each request, like the rest of the shop.
export const dynamic = 'force-dynamic';

/** Every page a search engine should know: the shop, each category, each product and each policy. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [base, products, categories, ui] = await Promise.all([
    siteBaseUrl(),
    StorefrontCatalog.sitemapProducts(),
    StorefrontCatalog.categories(),
    getCompanyUiConfigAction(),
  ]);
  return [
    { url: absoluteUrl(base, '/'), changeFrequency: 'daily', priority: 1 },
    ...categories.map((category) => ({ url: absoluteUrl(base, storefrontHref({ category: category.slug })), changeFrequency: 'daily' as const, priority: 0.7 })),
    ...products.map((product) => ({ url: absoluteUrl(base, productHref(product)), lastModified: product.updatedAt, changeFrequency: 'weekly' as const, priority: 0.8 })),
    ...ui.policies.map((page) => ({ url: absoluteUrl(base, policyAddress(page)), changeFrequency: 'monthly' as const, priority: 0.3 })),
  ];
}
