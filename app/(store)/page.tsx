import type { Metadata } from 'next';
import { StorefrontCatalog } from '@/server/domains/catalog/storefront-service';
import { getCompanySettingsAction } from '@/server/domains/company/actions';
import { Suspense } from 'react';
import { PromoBanners } from '@/components/store/PromoBanners';
import { ShopPage } from '@/components/store/shop/ShopPage';
import { has } from '@/lib/values';
import { hasStorefrontFilters, parseStorefrontQuery, storefrontHref, type SearchParamsInput } from '@/lib/storefront-search';

interface Props {
  searchParams: Promise<SearchParamsInput>;
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const query = parseStorefrontQuery(await searchParams);
  const company = await getCompanySettingsAction();
  const category = query.category === '' ? null : (await StorefrontCatalog.categories()).find((item) => item.slug === query.category);
  const title = query.q === '' ? (category?.name ?? 'Shop') : `Results for “${query.q}”`;
  const description = `Shop ${company.tradingName}${has(company.tagline) ? `: ${company.tagline}` : ''}. Browse products, add them to your cart and pay securely online.`;
  return {
    title,
    description,
    // The plain shop and each category are for search engines; searches, filters and later pages are not, so they never compete with them.
    alternates: { canonical: storefrontHref(category === null || category === undefined ? {} : { category: category.slug }) },
    robots: hasStorefrontFilters({ ...query, category: '' }) || query.cursor !== null || query.sort !== 'name' ? { index: false, follow: true } : undefined,
  };
}

export default function HomePage({ searchParams }: Props) {
  const queryPromise = searchParams.then(parseStorefrontQuery);
  const pagePromise = queryPromise.then((query) => StorefrontCatalog.search(query));
  return (
    <>
      <Suspense fallback={null}>
        <PromoBanners />
      </Suspense>
      <ShopPage queryPromise={queryPromise} pagePromise={pagePromise} priceRangePromise={StorefrontCatalog.priceRange()} />
    </>
  );
}
