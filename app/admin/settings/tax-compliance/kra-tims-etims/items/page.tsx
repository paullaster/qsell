import { etimsItemsPageAction, listEtimsTargetsAction } from '@/server/domains/kra/etims/actions';
import { EtimsItemsClient } from '@/components/admin/settings/EtimsItemsClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminEtimsItemsPage() {
  // The first page of items is fetched as soon as the first target is known, not after the screen draws.
  const targets = listEtimsTargetsAction();
  const firstItems = targets.then((r) => {
    const first = r.ok ? r.data[0] : undefined;
    return first?.usable === true ? etimsItemsPageAction({ branchId: first.branchId }) : null;
  });
  return (
    <SettingsFrame label="eTIMS items">
      <EtimsItemsClient targetsPromise={targets} firstItems={firstItems} />
    </SettingsFrame>
  );
}
