import { packagesScreenAction } from '@/server/domains/pricing/package-actions';
import { PackagesClient } from '@/components/admin/pricing/PackagesClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

/** The screen returns at once; its data is started here and read inside the frame, so nothing waits on anything else. */
export default function AdminPackagesPage() {
  return (
    <SettingsFrame label="the packages">
      <PackagesClient initialPromise={packagesScreenAction()} />
    </SettingsFrame>
  );
}
