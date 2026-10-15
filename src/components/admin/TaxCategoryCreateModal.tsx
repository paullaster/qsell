'use client';

import { useRouter } from 'next/navigation';
import { publishCatalogShortcut } from '@/components/admin/catalog-shortcuts';
import { RouteModal } from '@/components/admin/RouteModal';
import { TaxCategoryForm } from '@/components/admin/TaxCategoryForm';
import { cardClass } from '@/components/ui/screen-kit';

const CLASSIFICATION = '/admin/settings/tax-compliance/kra-tims-etims/classification';

export function TaxCategoryCreateModal({ presentation }: { presentation: 'intercepted' | 'page' }) {
  const router = useRouter();
  const close = () => {
    if (presentation === 'intercepted') router.back();
    else router.push(CLASSIFICATION);
  };

  const form = (
    <TaxCategoryForm
      tax={null}
      onCancel={close}
      onSaved={(tax) => {
        if (presentation === 'intercepted') {
          publishCatalogShortcut({ kind: 'tax', tax });
          router.back();
        } else {
          router.push(CLASSIFICATION);
          router.refresh();
        }
      }}
    />
  );

  if (presentation === 'intercepted') {
    return (
      <RouteModal title="Create tax schedule & category" onClose={close}>
        <p className="mb-3 text-xs text-fg-muted">Add a tax category, then return to the product form.</p>
        {form}
      </RouteModal>
    );
  }
  return (
    <div className={`${cardClass} max-w-xl space-y-3`}>
      <h2 className="text-base font-bold text-fg-strong">Create tax schedule & category</h2>
      {form}
    </div>
  );
}
