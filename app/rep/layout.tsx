import { BusinessTimeZoneProvider } from '@/components/business-time';
import { getContainer } from '@/server/di/container';
import type { Metadata, Viewport } from 'next';
import { RepShell } from '@/components/rep/RepShell';

/** The rep app is for signed-in reps only and is never listed by search engines. */
export const metadata: Metadata = {
  title: { default: 'Rep app', template: '%s · Rep app' },
  robots: { index: false, follow: false },
  manifest: '/rep/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'Rep', statusBarStyle: 'default' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default async function RepLayout({ children }: { children: React.ReactNode }) {
  const company = await getContainer().companySettings.ensureSeeded();
  return (
    <BusinessTimeZoneProvider timeZone={company.timezone}>
      <RepShell>{children}</RepShell>
    </BusinessTimeZoneProvider>
  );
}
