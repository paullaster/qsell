import type { MetadataRoute } from 'next';
import { siteBaseUrl } from '@/server/domains/storefront/site';

export const dynamic = 'force-dynamic';

/** The shop and its products are open to search engines; the console, accounts, checkout and the API are not. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const base = await siteBaseUrl();
  return {
    rules: [{ userAgent: '*', allow: ['/', '/api/media/file/', '/api/company/logo/'], disallow: ['/admin', '/api/', '/profile', '/checkout', '/login', '/register', '/forgot-password', '/reset-password', '/change-password', '/verify-email', '/vendor', '/quote/'] }],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
