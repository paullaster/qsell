import type { MetadataRoute } from 'next';
import { getCompanySettingsAction } from '@/server/domains/company/actions';

export const dynamic = 'force-dynamic';

/** Lets a phone add the shop to its home screen, named and coloured as the company set it up. */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const company = await getCompanySettingsAction();
  return {
    name: company.tradingName,
    short_name: company.tradingName.slice(0, 12),
    description: (company.tagline ?? '') === '' ? `${company.tradingName} online shop` : (company.tagline ?? ''),
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: company.primaryColor,
  };
}
