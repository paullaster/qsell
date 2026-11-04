import type { MetadataRoute } from 'next';
import { storefrontSeo } from '@/server/domains/storefront/seo';

export const dynamic = 'force-dynamic';

/** Lets a rider add the app to their phone's home screen, named after the company they ride for. */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const { company } = await storefrontSeo();
  return {
    name: `${company.tradingName} riders`,
    short_name: 'Rider',
    description: 'Your runs and the deliveries on them.',
    id: '/rider',
    start_url: '/rider',
    scope: '/rider',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: company.primaryColor,
  };
}
