import type { MetadataRoute } from 'next';
import { storefrontSeo } from '@/server/domains/storefront/seo';

export const dynamic = 'force-dynamic';

/** Lets a rep add the app to their phone's home screen, named after the company they sell for. */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const { company } = await storefrontSeo();
  return {
    name: `${company.tradingName} sales reps`,
    short_name: 'Rep',
    description: 'Your day, your customers and your van.',
    id: '/rep',
    start_url: '/rep',
    scope: '/rep',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: company.primaryColor,
  };
}
