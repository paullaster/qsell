import { auth } from '@/auth';
import { canPermission } from '@/server/domains/access-control/guard';

/** Signed in and allowed to read the media library: the bar for any private-media delivery. */
export async function canReadMedia(): Promise<boolean> {
  const id = (await auth())?.user.id;
  if (id === undefined || id === '') return false;
  return await canPermission('media:read');
}
