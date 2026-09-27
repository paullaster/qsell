/** Route logos through the runtime file handler, not Next's build-time public manifest. */
export function resolveCompanyLogoUrl(logoUrl?: string | null): string | null {
  if (!logoUrl) return null;
  const legacy = logoUrl.match(/^\/uploads\/company\/(logo-[a-zA-Z0-9._-]+)$/);
  if (legacy) return `/api/company/logo/${encodeURIComponent(legacy[1])}`;
  return logoUrl;
}
