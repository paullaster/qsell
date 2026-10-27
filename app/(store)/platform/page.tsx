import type { Metadata } from 'next';
import { platformCanonical, storefrontSeo } from '@/server/domains/storefront/seo';
import { PlatformPage } from '@/components/store/platform/PlatformPage';
import { pageSocial } from '@/lib/seo/social';
import { platformView, softwareJsonLd } from '@/lib/seo/platform';
import { absoluteUrl, breadcrumbJsonLd, jsonLdText } from '@/lib/product-seo';

export async function generateMetadata(): Promise<Metadata> {
  const { company, base } = await storefrontSeo();
  const view = platformView(company);
  return {
    title: view.title,
    description: view.description,
    keywords: view.keywords,
    // Many shops carry this page; when the platform has its own address, that one is named as the original.
    alternates: { canonical: platformCanonical() ?? '/platform' },
    ...pageSocial({ title: view.title, description: view.description, url: absoluteUrl(base, '/platform'), siteName: company.tradingName }),
  };
}

export default async function Platform() {
  const { company, base } = await storefrontSeo();
  const view = platformView(company);
  const trail = breadcrumbJsonLd([{ name: 'Shop', url: absoluteUrl(base, '/') }, { name: 'Software', url: absoluteUrl(base, '/platform') }]);
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(softwareJsonLd(view, absoluteUrl(base, '/platform'))) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(trail) }} />
      <PlatformPage view={view} />
    </>
  );
}
