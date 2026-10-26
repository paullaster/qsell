import { getContainer } from '@/server/di/container';
import { resolvePublicBaseUrl } from '@/server/domains/auth/account-service';

/**
 * The shop's own address (no trailing slash), from the company setting or the environment, never from the
 * request: a forged Host header must not put another site's address in the sitemap or in shared links.
 */
export async function siteBaseUrl(): Promise<string> {
  try {
    const company = await getContainer().companySettings.ensureSeeded();
    return resolvePublicBaseUrl(company.publicBaseUrl);
  } catch {
    return 'http://localhost:3000';
  }
}
