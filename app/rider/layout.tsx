import type { Metadata, Viewport } from 'next';
import { RegisterWorker } from '@/components/rider/RegisterWorker';
import { RiderShell } from '@/components/rider/RiderShell';

/** The rider app is for signed-in riders only and is never listed by search engines. */
export const metadata: Metadata = {
  title: { default: 'Rider app', template: '%s · Rider app' },
  robots: { index: false, follow: false },
  manifest: '/rider/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'Rider', statusBarStyle: 'default' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RiderLayout({ children }: { children: React.ReactNode }) {
  return (
    <RiderShell>
      <RegisterWorker />
      {children}
    </RiderShell>
  );
}
