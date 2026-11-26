import type { MetadataRoute } from 'next';
import { installedNames } from '@/lib/pwa-name';
import { storefrontSeo } from '@/server/domains/storefront/seo';

export const dynamic = 'force-dynamic';

/** Lets a phone add the shop to its home screen, named and coloured as the company set it up. */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const { company } = await storefrontSeo();
  const { name, shortName } = installedNames(company);
  return {
    name,
    short_name: shortName,
    description: (company.tagline ?? '') === '' ? `${company.tradingName} online shop` : (company.tagline ?? ''),
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: company.primaryColor,
  };
}
