'use server';

import { revalidatePath } from 'next/cache';
import { getContainer } from '@/server/di/container';
import { normalizeCondition } from './condition';
import { isPermissionKey } from './permissions';
import { type AccessSnapshot } from './engine';
import { requirePermission, requireUser } from './guard';
import type { GrantEffect, PolicyMatch, RoleWithGrants } from './repository';

export type { AccessSnapshot, RoleWithGrants, PolicyMatch };

export async function getMyAccessAction(): Promise<AccessSnapshot> {
  const userId = await requireUser();
  return getContainer().accessControl.snapshot(userId);
}

export async function listRolesAction(): Promise<RoleWithGrants[]> {
  await requirePermission('roles:read');
  return getContainer().accessControl.repo.listRoles();
}

export async function listPermissionsAction(): Promise<{ key: string; resource: string; action: string; category: string; description: string }[]> {
  await requirePermission('roles:read');
  const rows = await getContainer().accessControl.repo.listPermissions();
  return rows.map((r) => ({
    key: r.key,
    resource: r.resource,
    action: r.action,
    category: r.category,
    description: r.description,
  }));
}

export async function createRoleAction(input: {
  key: string;
  name: string;
  description?: string;
  priority?: number;
}): Promise<{ id: string; key: string }> {
  const actorId = await requirePermission('roles:manage');
  if (input.key.trim().toLowerCase() === 'super_admin') {
    throw new Error("The 'super_admin' role is reserved and provisioned by the system seeder.");
  }
  const container = getContainer();
  const role = await container.accessControl.repo.createRole({
    key: input.key,
    name: input.name,
    description: input.description,
    priority: input.priority,
    isSystem: false,
  });
  if (!role) throw new Error('Failed to create role');
  await writeAudit(actorId, 'roles:create', 'roles', role.key, {
    name: role.name,
    key: role.key,
  });
  revalidatePath('/admin/users/roles');
  return { id: role.id, key: role.key };
}

export async function updateRoleAction(
  roleId: string,
  input: { name?: string; description?: string; priority?: number; isActive?: boolean },
): Promise<void> {
  const actorId = await requirePermission('roles:manage');
  const container = getContainer();
  const existing = await container.accessControl.repo.findRoleById(roleId);
  if (!existing) throw new Error('Role not found');

  await container.accessControl.repo.updateRole(roleId, input);
  await invalidateRoleUsers(existing.key);
  await writeAudit(actorId, 'roles:update', 'roles', existing.key, {
    before: { name: existing.name, priority: existing.priority, isActive: existing.isActive },
    after: input,
  });
  revalidatePath('/admin/users/roles');
}

export async function deleteRoleAction(roleId: string): Promise<void> {
  const actorId = await requirePermission('roles:manage');
  const container = getContainer();
  const existing = await container.accessControl.repo.findRoleById(roleId);
  if (!existing) throw new Error('Role not found');

  await container.accessControl.repo.deleteRole(roleId);
  await invalidateRoleUsers(existing.key);
  await writeAudit(actorId, 'roles:delete', 'roles', existing.key, { name: existing.name });
  revalidatePath('/admin/users/roles');
}

export async function setRolePermissionsAction(
  roleId: string,
  grants: { permissionKey: string; effect: GrantEffect }[],
): Promise<void> {
  const actorId = await requirePermission('roles:manage');
  const container = getContainer();
  const existing = await container.accessControl.repo.findRoleById(roleId);
  if (!existing) throw new Error('Role not found');

  for (const grant of grants) {
    if (!isPermissionKey(grant.permissionKey)) {
      throw new Error(`Unknown permission '${grant.permissionKey}'`);
    }
  }

  await container.accessControl.repo.setRolePermissions(roleId, grants);
  await invalidateRoleUsers(existing.key);
  await writeAudit(actorId, 'roles:permissions_update', 'roles', existing.key, {
    grants: grants.map((g) => `${g.effect}:${g.permissionKey}`),
  });
  revalidatePath('/admin/users/roles');
}

export async function listPoliciesAction(permissionKey?: string): Promise<PolicyMatch[]> {
  await requirePermission('policies:read');
  return getContainer().accessControl.repo.listPolicies(permissionKey);
}

export async function createPolicyAction(input: {
  key: string;
  name: string;
  permissionKey: string;
  description?: string;
  condition: Record<string, unknown>;
  effect: GrantEffect;
  priority: number;
}): Promise<PolicyMatch> {
  const actorId = await requirePermission('policies:manage');
  const container = getContainer();
  const created = await container.accessControl.repo.createPolicy({
    ...input,
    condition: normalizeCondition(input.condition),
    createdBy: actorId,
  });
  if (!created) throw new Error('Failed to create policy');
  container.accessControl.invalidatePolicies();
  await writeAudit(actorId, 'policies:create', 'access_policies', created.key, {
    name: created.name,
    permissionKey: created.permissionKey,
  });
  revalidatePath('/admin/users/policies');
  return {
    id: created.id,
    key: created.key,
    name: created.name,
    description: created.description,
    permissionKey: created.permissionKey,
    condition: created.condition,
    effect: created.effect,
    priority: created.priority,
    isEnabled: created.isEnabled,
  };
}

export async function updatePolicyAction(
  policyId: string,
  input: Partial<{
    name: string;
    permissionKey: string;
    description: string;
    condition: Record<string, unknown>;
    effect: GrantEffect;
    priority: number;
    isEnabled: boolean;
  }>,
): Promise<void> {
  const actorId = await requirePermission('policies:manage');
  const container = getContainer();
  const existing = await container.accessControl.repo.listPolicies();
  const policy = existing.find((p) => p.id === policyId);
  if (!policy) throw new Error('Policy not found');

  const patch = { ...input };
  if (patch.condition !== undefined) {
    patch.condition = normalizeCondition(patch.condition);
  }

  await container.accessControl.repo.updatePolicy(policyId, patch);
  container.accessControl.invalidatePolicies();
  await writeAudit(actorId, 'policies:update', 'access_policies', policy.key, {
    before: { name: policy.name, effect: policy.effect, enabled: policy.isEnabled },
    after: input,
  });
  revalidatePath('/admin/users/policies');
}

export async function deletePolicyAction(policyId: string): Promise<void> {
  const actorId = await requirePermission('policies:manage');
  const container = getContainer();
  const existing = await container.accessControl.repo.listPolicies();
  const policy = existing.find((p) => p.id === policyId);
  if (!policy) throw new Error('Policy not found');

  await container.accessControl.repo.deletePolicy(policyId);
  container.accessControl.invalidatePolicies();
  await writeAudit(actorId, 'policies:delete', 'access_policies', policy.key, {
    name: policy.name,
  });
  revalidatePath('/admin/users/policies');
}

export async function listAuditsAction(limit = 100): Promise<
  { id: string; action: string; resource: string; resourceId: string | null; detail: Record<string, unknown> | null; createdAt: Date }[]
> {
  await requirePermission('audits:read');
  const rows = await getContainer().accessControl.repo.listAudits(limit);
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    resource: r.resource,
    resourceId: r.resourceId ?? null,
    detail: r.detail ?? null,
    createdAt: r.createdAt,
  }));
}

export async function listAccessBranchesAction(): Promise<{ id: string; name: string; code: string; isDefault: boolean }[]> {
  await requirePermission('users:read');
  const rows = await getContainer().branches.listActive();
  return rows.map((r) => ({ id: r.id, name: r.name, code: r.code, isDefault: r.isDefault }));
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

async function invalidateRoleUsers(roleKey: string): Promise<void> {
  const container = getContainer();
  const ids = await container.accessControl.repo.listUserIdsByRoleKey(roleKey);
  for (const id of ids) container.accessControl.invalidateUser(id);
}