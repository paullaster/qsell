'use client';

import { useRouter } from 'next/navigation';
import { publishCatalogShortcut } from '@/components/admin/catalog-shortcuts';
import { RouteModal } from '@/components/admin/RouteModal';
import { UnitForm } from '@/components/admin/settings/UnitForm';
import { cardClass } from '@/components/ui/screen-kit';

const LIST = '/admin/settings/units';

/** Makes a unit of measure over the screen the person was on (the product form), or as a page on a direct visit. */
export function UnitCreateModal({ presentation }: { presentation: 'intercepted' | 'page' }) {
  const router = useRouter();
  const close = () => {
    if (presentation === 'intercepted') router.back();
    else router.push(LIST);
  };

  const form = (
    <UnitForm
      unit={null}
      autoFocus
      onCancel={close}
      onSaved={(saved) => {
        if (presentation === 'intercepted') {
          publishCatalogShortcut({
            kind: 'unit',
            unit: {
              id: saved.id,
              label: `${saved.code} · ${saved.name}`,
              decimals: saved.decimals,
            },
          });
          router.back();
        } else {
          router.push(LIST);
          router.refresh();
        }
      }}
    />
  );

  if (presentation === 'intercepted') {
    return (
      <RouteModal title="Create unit of measure" onClose={close}>
        <p className="mb-3 text-xs text-fg-muted">Add a unit, then return to where you were.</p>
        {form}
      </RouteModal>
    );
  }
  return (
    <div className={`${cardClass} max-w-2xl space-y-3`}>
      <h2 className="text-base font-bold text-fg-strong">Create unit of measure</h2>
      {form}
    </div>
  );
}
