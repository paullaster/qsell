'use server';

import { revalidatePath } from 'next/cache';
import { getContainer } from '@/server/di/container';
import { requirePermission } from '@/server/domains/access-control/guard';
import { isPermissionKey } from '@/server/domains/access-control/permissions';
import type {
  CreateUserInput,
  DirectGrantInput,
  RoleAssignment,
  UpdateUserInput,
  UserListEntry,
  UserListResult,
} from './repository';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertValidPassword(password: string): void {
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
}

function assertValidEmail(email: string): void {
  if (!EMAIL_RE.test(email)) throw new Error('A valid email address is required');
}

function assertValidName(name: string): void {
  if (name.trim() === '') throw new Error('A display name is required');
}

function isSuperAdminRole(role: string): boolean {
  return role === 'super_admin';
}

const PROVISIONED_SUPER_ADMIN_MSG =
  'The super_admin account is provisioned by the system seeder and cannot be created or reassigned from the user module.';

export async function listUsersAction(input: {
  search?: string;
  role?: string;
  status?: string;
  branchId?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<UserListResult> {
  const actorId = await requirePermission('users:read');
  const canView = await getContainer().usersAdmin.canViewSuperAdmins(actorId);
  return getContainer().usersAdmin.listUsers({ ...input, hideSuperAdmins: !canView });
}

export async function getUserDetailAction(userId: string): Promise<{
  id: string;
  email: string;
  name: string;
  title: string | null;
  phone: string | null;
  role: string;
  status: string;
  branchId: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  extraRoles: { id: string; key: string; name: string; priority: number; isSystem: boolean }[];
  directGrants: DirectGrantInput[];
} | null> {
  const actorId = await requirePermission('users:read');
  const detail = await getContainer().usersAdmin.getUserDetail(userId);
  if (!detail) return null;
  if (isSuperAdminRole(detail.user.role)) {
    const canView = await getContainer().usersAdmin.canViewSuperAdmins(actorId);
    if (!canView) return null;
  }
  const { user, extraRoles, directGrants } = detail;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    title: user.title,
    phone: user.phone,
    role: user.role,
    status: user.status,
    branchId: user.branchId,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    extraRoles: extraRoles.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      priority: r.priority,
      isSystem: r.isSystem,
    })),
    directGrants,
  };
}

export async function createUserAction(input: CreateUserInput): Promise<UserListEntry> {
  const actorId = await requirePermission('users:create');
  assertValidEmail(input.email);
  assertValidPassword(input.password);
  assertValidName(input.name);

  if (isSuperAdminRole(input.role)) {
    throw new Error(PROVISIONED_SUPER_ADMIN_MSG);
  }
  if (input.role === '') throw new Error('A primary role is required');

  const container = getContainer();
  const row = await container.usersAdmin.createUser(input);
  container.accessControl.invalidateUser(row.id);
  await writeAudit(actorId, 'users:create', 'users', row.id, {
    email: row.email,
    name: row.name,
    role: row.role,
    extraRoles: sanitizeRoles(input.extraRoles),
  });
  revalidatePath('/admin/users');
  return toListEntry(row, input.extraRoles ?? []);
}

export async function updateUserAction(userId: string, input: UpdateUserInput): Promise<void> {
  const actorId = await requirePermission('users:update');
  const container = getContainer();

  const existing = await container.usersAdmin.getUserDetail(userId);
  if (!existing) throw new Error('User not found');

  if (
    input.role !== undefined &&
    isSuperAdminRole(input.role) &&
    !isSuperAdminRole(existing.user.role)
  ) {
    throw new Error(PROVISIONED_SUPER_ADMIN_MSG);
  }

  if (isSuperAdminRole(existing.user.role)) {
    await assertActorIsSuperAdmin(actorId);
    if (input.role !== undefined && input.role !== existing.user.role) {
      const count = await container.usersAdmin.countSuperAdmins();
      if (count <= 1) throw new Error('Cannot demote the last super administrator');
    }
  }

  if (input.branchId === '') input.branchId = null;

  const updated = await container.usersAdmin.updateUser(userId, input);
  container.accessControl.invalidateUser(userId);
  await writeAudit(actorId, 'users:update', 'users', userId, {
    before: {
      role: existing.user.role,
      status: existing.user.status,
      branchId: existing.user.branchId,
      isActive: existing.user.isActive,
      name: existing.user.name,
    },
    after: {
      role: updated?.role,
      status: updated?.status,
      branchId: updated?.branchId,
      isActive: updated?.isActive,
      name: updated?.name,
    },
  });
  revalidatePath('/admin/users');
}

export async function deleteUserAction(userId: string): Promise<void> {
  const actorId = await requirePermission('users:delete');
  if (userId === actorId) throw new Error('You cannot delete your own account');

  const container = getContainer();
  const existing = await container.usersAdmin.getUserDetail(userId);
  if (!existing) throw new Error('User not found');

  if (isSuperAdminRole(existing.user.role)) {
    await assertActorIsSuperAdmin(actorId);
    const count = await container.usersAdmin.countSuperAdmins();
    if (count <= 1) throw new Error('Cannot delete the last super administrator');
  }

  await container.usersAdmin.deleteUser(userId);
  container.accessControl.invalidateUser(userId);
  await writeAudit(actorId, 'users:delete', 'users', userId, {
    email: existing.user.email,
    role: existing.user.role,
  });
  revalidatePath('/admin/users');
}

export async function resetUserPasswordAction(userId: string, newPassword: string): Promise<void> {
  const actorId = await requirePermission('users:reset_password');
  assertValidPassword(newPassword);

  const container = getContainer();
  const existing = await container.usersAdmin.getUserDetail(userId);
  if (!existing) throw new Error('User not found');
  if (isSuperAdminRole(existing.user.role)) await assertActorIsSuperAdmin(actorId);

  await container.usersAdmin.resetPassword(userId, newPassword);
  await writeAudit(actorId, 'users:reset_password', 'users', userId, { reason: 'admin_reset' });
  revalidatePath('/admin/users');
}

export async function assignRolesAction(userId: string, assignments: RoleAssignment[]): Promise<void> {
  const actorId = await requirePermission('users:manage_roles');
  const container = getContainer();
  const existing = await container.usersAdmin.getUserDetail(userId);
  if (!existing) throw new Error('User not found');

  const keys = [...new Set(assignments.map((a) => a.roleKey))];
  if (keys.some((k) => isSuperAdminRole(k))) {
    throw new Error(PROVISIONED_SUPER_ADMIN_MSG);
  }
  const roles = await container.accessControl.repo.listRoles();
  const activeKeys = new Set(roles.filter((r) => r.isActive).map((r) => r.key));
  for (const key of keys) {
    if (!activeKeys.has(key)) throw new Error(`Role '${key}' is not available`);
  }

  await container.usersAdmin.setExtraRoles(userId, assignments, actorId);
  container.accessControl.invalidateUser(userId);
  await writeAudit(actorId, 'users:assign_roles', 'users', userId, {
    before: existing.extraRoles.map((r) => r.key),
    after: keys,
  });
  revalidatePath('/admin/users');
}

export async function setDirectGrantsAction(userId: string, grants: DirectGrantInput[]): Promise<void> {
  const actorId = await requirePermission('users:manage_roles');
  const container = getContainer();
  const existing = await container.usersAdmin.getUserDetail(userId);
  if (!existing) throw new Error('User not found');

  for (const grant of grants) {
    if (!isPermissionKey(grant.permissionKey)) {
      throw new Error(`Unknown permission '${grant.permissionKey}'`);
    }
  }

  await container.usersAdmin.setDirectGrants(userId, grants);
  container.accessControl.invalidateUser(userId);
  await writeAudit(actorId, 'users:set_direct_grants', 'users', userId, {
    before: existing.directGrants.map((g) => grantKey(g.permissionKey, g.effect)),
    after: grants.map((g) => grantKey(g.permissionKey, g.effect)),
  });
  revalidatePath('/admin/users');
}

async function assertActorIsSuperAdmin(actorId: string): Promise<void> {
  const snapshot = await getContainer().accessControl.snapshot(actorId);
  if (!snapshot.superAdmin) {
    throw new Error('Only a super administrator can assign the super_admin role');
  }
}

function grantKey(permissionKey: string, effect: string): string {
  return `${effect}:${permissionKey}`;
}

function sanitizeRoles(roles: RoleAssignment[] | undefined): unknown {
  return (roles ?? []).map((r) => ({
    key: r.roleKey,
    branchId: r.branchId ?? null,
  }));
}

async function writeAudit(
  actorId: string,
  action: string,
  resource: string,
  resourceId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await getContainer().accessControl.repo.insertAudit({
    actorUserId: actorId,
    action,
    resource,
    resourceId,
    detail,
  });
}

function toListEntry(row: { id: string; email: string; name: string; title: string | null; phone: string | null; role: string; status: string; branchId: string | null; isActive: boolean; mustChangePassword: boolean; lastLoginAt: Date | null; createdAt: Date; updatedAt: Date }, extraRoles: RoleAssignment[]): UserListEntry {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    title: row.title,
    phone: row.phone,
    role: row.role,
    status: row.status,
    branchId: row.branchId,
    isActive: row.isActive,
    mustChangePassword: row.mustChangePassword,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    extraRoles: extraRoles.map((r) => r.roleKey),
  };
}

export async function listUsersByRoleAction(role: string): Promise<UserListEntry[]> {
  await requirePermission('users:read');
  const result = await getContainer().usersAdmin.listUsers({ role, pageSize: 200 });
  return result.rows;
}