import { ProjectsClient } from '@/components/admin/projects/ProjectsClient';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { listProjectsAction } from '@/server/domains/projects/actions';

export default function Page() {
  return (
    <SettingsFrame label="projects">
      <ProjectsClient initialPromise={listProjectsAction()} />
    </SettingsFrame>
  );
}
