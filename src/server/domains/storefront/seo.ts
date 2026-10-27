import { cache } from 'react';
import { resolveCompanyUiConfig } from '@/config/company-ui';
import { toPublicCompany } from '@/lib/company-view';
import { readCompanyRow } from '@/server/domains/storefront/company-read';
import { siteBaseUrl } from '@/server/domains/storefront/site';

/** What every public page needs to describe the business: the company, its help content and the shop's address. One read of the company per request. */
export const storefrontSeo = cache(async () => {
  const [row, base] = await Promise.all([readCompanyRow(), siteBaseUrl()]);
  return { company: toPublicCompany(row), ui: resolveCompanyUiConfig(row.uiConfig), base };
});

/** Codes Google and Bing give to prove who owns the site (set in the environment, per deployment). */
export function siteVerification(env: NodeJS.ProcessEnv = process.env): { google?: string; other?: Record<string, string> } {
  const google = env.GOOGLE_SITE_VERIFICATION?.trim() ?? '';
  const bing = env.BING_SITE_VERIFICATION?.trim() ?? '';
  return {
    ...(google === '' ? {} : { google }),
    ...(bing === '' ? {} : { other: { 'msvalidate.01': bing } }),
  };
}

/** The address the platform page names as its original, so many shops carrying the same page do not compete with each other. */
export function platformCanonical(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PLATFORM_CANONICAL_URL?.trim() ?? '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}
