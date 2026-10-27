import type { Metadata } from 'next';
import { StorefrontCatalog } from '@/server/domains/catalog/storefront-service';
import { storefrontSeo } from '@/server/domains/storefront/seo';
import { ShopAbout } from '@/components/store/ShopAbout';
import { pageSocial } from '@/lib/seo/social';
import { shareImageUrl } from '@/lib/seo/share';
import { resolveCompanyLogoUrl } from '@/lib/companyLogo';
import { absoluteUrl } from '@/lib/product-seo';
import { categoryDescription, categoryTitle, homeDescription, homeKeywords, homeTitle } from '@/lib/seo/text';
import { Suspense } from 'react';
import { PromoBanners } from '@/components/store/PromoBanners';
import { ShopPage } from '@/components/store/shop/ShopPage';
import { hasStorefrontFilters, parseStorefrontQuery, storefrontHref, type SearchParamsInput } from '@/lib/storefront-search';

/** The page title: what was searched for, else the category, else the shop's own title without the template. */
function searchTitle(search: string, category: string | null, home: string): string | { absolute: string } {
  if (search !== '') return `Results for “${search}”`;
  return category ?? { absolute: home };
}

interface Props {
  searchParams: Promise<SearchParamsInput>;
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const query = parseStorefrontQuery(await searchParams);
  const [{ company, ui, base }, categories] = await Promise.all([storefrontSeo(), StorefrontCatalog.categories()]);
  const category = query.category === '' ? null : categories.find((item) => item.slug === query.category);
  const topNames = categories.filter((item) => item.depth === 0).map((item) => item.name);
  const categoryName = category?.name ?? null;
  const title = searchTitle(query.q, categoryName === null ? null : categoryTitle(company, categoryName), homeTitle(company));
  const description = categoryName === null ? homeDescription(company, { categories: topNames, guarantee: ui.support.guarantees[0]?.text }) : categoryDescription(company, categoryName);
  const canonical = storefrontHref(category === null || category === undefined ? {} : { category: category.slug });
  const logo = resolveCompanyLogoUrl(company.logoUrl);
  const shareLogo = logo === null ? null : shareImageUrl(base, logo);
  const plainTitle = typeof title === 'string' ? title : title.absolute;
  return {
    title,
    description,
    keywords: homeKeywords(company, categoryName === null ? topNames : [categoryName, ...topNames]),
    // The plain shop and each category are for search engines; searches, filters and later pages are not, so they never compete with them.
    alternates: { canonical },
    ...pageSocial({ title: plainTitle, description, url: absoluteUrl(base, canonical), siteName: company.tradingName, image: shareLogo }),
    ...(hasStorefrontFilters({ ...query, category: '' }) || query.cursor !== null || query.sort !== 'name' ? { robots: { index: false, follow: true } } : {}),
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
      <Suspense fallback={null}>
        <ShopAbout queryPromise={queryPromise} />
      </Suspense>
    </>
  );
}
