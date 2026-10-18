import { NewProjectClient } from '@/components/admin/projects/NewProjectClient';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { projectStartAction } from '@/server/domains/projects/actions';

export default function Page() {
  return (
    <SettingsFrame label="the new project">
      <NewProjectClient startPromise={projectStartAction()} />
    </SettingsFrame>
  );
}
