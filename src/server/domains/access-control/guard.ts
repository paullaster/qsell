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

export async function requireUser(): Promise<string> {
  const session = await auth();
  const id = session?.user.id;
  if (id === undefined || id === '') {
    throw new AccessDeniedError('*', { allowed: false, reason: 'deny-grant' });
  }
  return id;
}

export async function requirePermission(
  permissionKey: PermissionKey,
  ctx?: AccessContext,
): Promise<string> {
  const userId = await requireUser();
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
  return await getContainer().accessControl.can(id, permissionKey, ctx);
}

export async function myAccessSnapshot(): Promise<AccessSnapshot> {
  const userId = await requireUser();
  return await getContainer().accessControl.snapshot(userId);
}

export { AccessControlService, AccessDeniedError };
export type { AccessContext, AccessSnapshot, PermissionKey };