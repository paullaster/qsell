import { listSigningEventsAction } from '@/server/domains/kra/signing/actions';
import { SigningLogClient } from '@/components/admin/settings/SigningLogClient';

export default async function AdminKraSigningLogPage() {
  const events = await listSigningEventsAction({ limit: 300 });
  return <SigningLogClient events={events} />;
}
