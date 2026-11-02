import type { Metadata } from 'next';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { VendorInvitationAcceptClient } from '@/components/vendor/VendorInvitationAcceptClient';

export const metadata: Metadata = { title: 'Accept vendor invitation', robots: { index: false, follow: false } };

export default async function AcceptVendorInvitationPage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const query = await searchParams;
  const token = typeof query.token === 'string' ? query.token : '';
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center gap-4 bg-canvas px-4 py-10">
      <div className="absolute top-4 right-4"><ThemeToggle /></div>
      <VendorInvitationAcceptClient token={token} />
    </div>
  );
}
