import { auth } from '@/auth';
import { getContainer } from '@/server/di/container';
import {
  AccessControlService,
  AccessDeniedError,
  type AccessContext,
  type AccessSnapshot,
} from './engine';
import { type PermissionKey } from './permissions';

/**
 * Guards for server actions / route handlers. All guarded actions MUST call
 * these — the UI hides what the guard forbids, but the guard is the bound.
 */

/** The signed-in user, or an access error. One session read per call. */
async function signedInUser(): Promise<{ id: string; role: string; isStaff: boolean }> {
  const session = await auth();
  const id = session?.user.id;
  if (id === undefined || id === '') {
    throw new AccessDeniedError('*', { allowed: false, reason: 'deny-grant' });
  }
  // The proxy redirects pages; this closes the same gap for direct server-action calls.
  if (session?.user.mustChangePassword === true) {
    throw new Error('Change your temporary password before continuing.');
  }
  return {
    id,
    role: session?.user.role ?? 'customer',
    isStaff: session?.user.isStaff === true,
  };
}

export async function requireUser(): Promise<string> {
  return (await signedInUser()).id;
}

/**
 * Signed-in staff member (primary role flagged as a staff role). The session role is
 * re-validated against the database at least every minute (see auth.ts).
 */
export async function requireStaff(): Promise<string> {
  const user = await signedInUser();
  if (!user.isStaff) {
    throw new AccessDeniedError('*', { allowed: false, reason: 'deny-grant' });
  }
  return user.id;
}

/**
 * Every permission in the catalog is a back-office capability, so the caller
 * must also hold a staff primary role. A customer account that somehow carries
 * a grant (a stray extra role or direct grant) still cannot invoke admin actions.
 */
export async function requirePermission(
  permissionKey: PermissionKey,
  ctx?: AccessContext,
): Promise<string> {
  const userId = await requireStaff();
  await getContainer().accessControl.assert(userId, permissionKey, ctx);
  return userId;
}

export async function canPermission(
  permissionKey: PermissionKey,
  ctx?: AccessContext,
): Promise<boolean> {
  const session = await auth();
  const id = session?.user.id;
  if (id === undefined || id === '') return false;
  if (session?.user.mustChangePassword === true) return false;
  return await getContainer().accessControl.can(id, permissionKey, ctx);
}

export async function myAccessSnapshot(): Promise<AccessSnapshot> {
  const userId = await requireUser();
  return await getContainer().accessControl.snapshot(userId);
}

export { AccessControlService, AccessDeniedError };
export type { AccessContext, AccessSnapshot, PermissionKey };