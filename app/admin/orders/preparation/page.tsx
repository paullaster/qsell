import { preparationSheetAction } from '@/server/domains/pricing/preparation-actions';
import { PreparationClient } from '@/components/admin/orders/PreparationClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

/** The screen returns at once; today's sheet is started here and read inside the frame, so nothing waits on anything else. */
export default function PreparationPage() {
  return (
    <SettingsFrame label="the preparation sheet">
      <PreparationClient initialPromise={preparationSheetAction()} />
    </SettingsFrame>
  );
}
