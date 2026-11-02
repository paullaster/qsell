import { auth } from '@/auth';
import { findPortalAccess, type PortalAccess } from './portal-access';

export class PortalAccessError extends Error {
  constructor() {
    super('Sign in to the vendor portal to continue.');
  }
}

/**
 * The vendor business the caller acts for, taken from their session and checked against the database again. Every portal
 * action starts here: the vendor id is NEVER read from the request, so one vendor cannot name another's records.
 */
export async function requirePortalVendor(): Promise<PortalAccess & { userId: string; name: string }> {
  const session = await auth();
  const user = session?.user;
  if (user === undefined || user.isStaff || (user.role !== 'vendor' && user.role !== 'customer')) throw new PortalAccessError();
  const access = await findPortalAccess(user.id);
  if (access === null) throw new PortalAccessError();
  return { ...access, userId: user.id, name: user.name };
}
