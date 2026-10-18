import { ProjectDetailClient } from '@/components/admin/projects/ProjectDetailClient';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { MissingAs404 } from '@/components/ui/missing-record';
import { projectDetailAction } from '@/server/domains/projects/actions';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => projectDetailAction(id));
  return (
    <SettingsFrame label="the project">
      <MissingAs404 result={view}>
        <ProjectDetailClient viewPromise={view} />
      </MissingAs404>
    </SettingsFrame>
  );
}
