
import { has } from '@/lib/values';
/** Route logos through the runtime file handler, not Next's build-time public manifest. */
export function resolveCompanyLogoUrl(logoUrl?: string | null): string | null {
  if (!has(logoUrl)) return null;
  const legacy = /^\/uploads\/company\/(logo-[a-zA-Z0-9._-]+)$/.exec(logoUrl);
  if (legacy) return `/api/company/logo/${encodeURIComponent(legacy[1])}`;
  return logoUrl;
}
