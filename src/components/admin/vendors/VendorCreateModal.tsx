'use client';

import { useRouter } from 'next/navigation';
import { RouteModal } from '@/components/admin/RouteModal';
import { cardClass } from '@/components/ui/screen-kit';
import { VendorCreateForm } from './VendorCreateForm';

/** The add-vendor window over the screen that asked for it, or the same form as a page of its own. */
export function VendorCreateModal({ presentation, canActivate }: { presentation: 'intercepted' | 'page'; canActivate: boolean }) {
  const router = useRouter();
  const close = () => {
    if (presentation === 'intercepted') router.back();
    else router.push('/admin/vendors');
  };
  const form = (
    <VendorCreateForm
      canActivate={canActivate}
      onCancel={close}
      onSaved={(vendor) => {
        router.push(`/admin/vendors/${vendor.id}`);
        router.refresh();
      }}
    />
  );
  if (presentation === 'intercepted') {
    return (
      <RouteModal title="Add a vendor" onClose={close}>
        <p className="mb-3 text-xs text-fg-muted">The vendor completes its own profile when it signs in to the vendor portal.</p>
        {form}
      </RouteModal>
    );
  }
  return (
    <div className={`${cardClass} max-w-xl space-y-3`}>
      <h2 className="text-base font-bold text-fg-strong">Add a vendor</h2>
      {form}
    </div>
  );
}
