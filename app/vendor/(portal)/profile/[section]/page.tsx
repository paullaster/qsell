import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { profileFormAction } from '@/server/domains/vendors/profile-actions';
import { bankStatusAction } from '@/server/domains/vendors/portal-team-actions';
import { BankChangeClient } from '@/components/vendor/BankChangeClient';
import { SectionClient } from '@/components/vendor/SectionClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { isSection } from '@/lib/vendor-profile';

export default async function VendorProfileSectionPage({ params }: { params: Promise<{ section: string }> }) {
  // Whether the address names a real part of the profile is decided before anything is drawn.
  const { section } = await params;
  if (!isSection(section)) notFound();
  const form = profileFormAction(section);
  const bank = section === 'financial' ? bankStatusAction() : null;
  return (
    <>
      <Suspense fallback={<PageSkeleton label="this part of your profile" />}>
        <SectionClient formPromise={form} />
      </Suspense>
      {bank === null ? null : (
        <div className="mt-5 max-w-3xl">
          <Suspense fallback={<PageSkeleton label="your bank details" />}>
            <BankChangeClient statusPromise={bank} />
          </Suspense>
        </div>
      )}
    </>
  );
}
