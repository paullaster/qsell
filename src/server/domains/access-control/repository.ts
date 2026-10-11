import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  accessPolicies,
  auditLogs,
  permissions,
  rolePermissions,
  roles,
  userPermissions,
  userRoles,
  users,
  type AccessPolicyRow,
  type AuditLogInsert,
  type AuditLogRow,
  type PermissionRow,
  type RolePermissionRow,
  type RoleRow,
} from '@/server/db/drizzle/schema';
import { isPermissionKey } from './permissions';

export type GrantEffect = 'allow' | 'deny';

/** One resolved permission grant after role + direct sources are merged. */
export interface PermissionGrant {
  permissionKey: string;
  effect: GrantEffect;
  source: 'role' | 'direct';
  /** Branch scope of the grant; null means it applies globally (any context). */
  scopeBranchId: string | null;
  roleKey: string | null;
  rolePriority: number;
}

export interface UserAccessModel {
  userId: string;
  isActive: boolean;
  status: string;
  permissionsVersion: number;
  /** True when the user holds the super_admin role (primary `users.role` or an extra assignment). */
  superAdmin: boolean;
  grants: PermissionGrant[];
  /** User attributes exposed to ABAC conditions via `user.*`. */
  attrs: Record<string, unknown>;
}

export interface RoleWithGrants {
  id: string;
  key: string;
  name: string;
  description: string;
  priority: number;
  isSystem: boolean;
  isActive: boolean;
  isStaff: boolean;
  grants: { permissionKey: string; effect: GrantEffect }[];
}

export interface PolicyMatch {
  id: string;
  key: string;
  name: string;
  description: string;
  permissionKey: string;
  condition: Record<string, unknown>;
  effect: GrantEffect;
  priority: number;
  isEnabled: boolean;
}

/** Arbitrary constant naming the seed's cluster-wide advisory lock. */
const SEED_LOCK_KEY = 0x5eed_ac1;

export class AccessControlRepository {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * Run `work` in one transaction holding a cluster-wide advisory lock, so
   * concurrent boots (app replicas, the worker) seed one at a time and a crash
   * mid-seed rolls back cleanly instead of leaving a role without its grants.
   */
  async runExclusive<T>(work: (repo: AccessControlRepository) => Promise<T>): Promise<T> {
    return await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SEED_LOCK_KEY})`);
      // A transaction exposes the same query API; nested .transaction() calls become savepoints.
      return await work(new AccessControlRepository(tx as unknown as DrizzleDb));
    });
  }

  async getUserAccessModel(userId: string): Promise<UserAccessModel | null> {
    const userRows = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = userRows.at(0) ?? null;
    if (!user) return null;

    const primaryRoleKey = user.role;

    // Extra role assignments (branch-scoped allowed).
    const assignments = await this.db
      .select({
        roleId: userRoles.roleId,
        branchId: userRoles.branchId,
      })
      .from(userRoles)
      .where(eq(userRoles.userId, userId));

    const roleIds = assignments.length > 0 ? assignments.map((a) => a.roleId) : [];

    const primaryRoleRows = await this.db
      .select()
      .from(roles)
      .where(and(eq(roles.key, primaryRoleKey), eq(roles.isActive, true)))
      .limit(1);
    const primaryRole = primaryRoleRows.at(0) ?? null;

    const extraRoleRows =
      roleIds.length > 0
        ? await this.db
            .select()
            .from(roles)
            .where(and(inArray(roles.id, roleIds), eq(roles.isActive, true)))
        : [];

    // Role → (roleId, scope) mapping for grant scoping.
    const assignmentScopes = new Map<string, string | null>(); // roleId -> branchId
    for (const a of assignments) assignmentScopes.set(a.roleId, a.branchId);
    // Primary role always applies globally (not branch-scoped).
    if (primaryRole) assignmentScopes.set(primaryRole.id, null);

    const allRoleIds = [
      ...(primaryRole ? [primaryRole.id] : []),
      ...extraRoleRows.map((r) => r.id),
    ];

    const roleGrantRows: RolePermissionRow[] =
      allRoleIds.length > 0
        ? await this.db
            .select()
            .from(rolePermissions)
            .where(
              and(
                inArray(rolePermissions.roleId, allRoleIds),
                sql`exists (select 1 from permissions p where p.id = ${rolePermissions.permissionId} and p.is_active = true)`,
              ),
            )
        : [];

    const roleKeyById = new Map<string, string>();
    const rolePriorityById = new Map<string, number>();
    if (primaryRole) {
      roleKeyById.set(primaryRole.id, primaryRole.key);
      rolePriorityById.set(primaryRole.id, primaryRole.priority);
    }
    for (const role of extraRoleRows) {
      roleKeyById.set(role.id, role.key);
      rolePriorityById.set(role.id, role.priority);
    }

    const grants: PermissionGrant[] = [];
    const seenPermissionIds = new Map<string, GrantEffect>(); // roleId|permissionId
    for (const row of roleGrantRows) {
      const scope = assignmentScopes.get(row.roleId) ?? null;
      const roleKey = roleKeyById.get(row.roleId) ?? null;
      const rolePriority = rolePriorityById.get(row.roleId) ?? 100;
      grants.push({
        permissionKey: row.permissionId, // replaced below with actual key
        effect: row.effect,
        source: 'role',
        scopeBranchId: scope,
        roleKey,
        rolePriority,
      });
      seenPermissionIds.set(row.permissionId, row.effect);
    }

    // Resolve permission IDs → keys in one pass.
    const permissionRows =
      grants.length > 0
        ? await this.db.select().from(permissions).where(inArray(permissions.id, [...seenPermissionIds.keys()]))
        : [];

    const keyById = new Map(permissionRows.map((p) => [p.id, p.key]));
    for (const grant of grants) {
      grant.permissionKey = keyById.get(grant.permissionKey) ?? 'unknown';
    }

    // Direct user grants/denials (unexpired).
    const directRows =
      await this.db
        .select({
          permissionKey: permissions.key,
          effect: userPermissions.effect,
          branchId: userPermissions.branchId,
        })
        .from(userPermissions)
        .innerJoin(permissions, eq(permissions.id, userPermissions.permissionId))
        .where(
          and(
            eq(userPermissions.userId, userId),
            eq(permissions.isActive, true),
            or(isNull(userPermissions.expiresAt), sql`${userPermissions.expiresAt} > now()`),
          ),
        );

    for (const row of directRows) {
      grants.push({
        permissionKey: row.permissionKey,
        effect: row.effect,
        source: 'direct',
        scopeBranchId: row.branchId,
        roleKey: null,
        rolePriority: 0,
      });
    }

    const superAdmin =
      user.role === 'super_admin' ||
      grants.some((g) => g.source === 'role' && g.roleKey === 'super_admin');

    return {
      userId: user.id,
      isActive: user.isActive && user.status === 'active',
      status: user.status,
      permissionsVersion: user.permissionsVersion,
      superAdmin,
      grants,
      attrs: {
        id: user.id,
        email: user.email,
        name: user.name,
        title: user.title,
        phone: user.phone,
        role: user.role,
        status: user.status,
        branchId: user.branchId,
        customerStoreId: user.customerStoreId,
        isActive: user.isActive,
        mustChangePassword: user.mustChangePassword,
      },
    };
  }

  async listPolicies(permissionKey?: string): Promise<PolicyMatch[]> {
    const where = permissionKey === undefined ? undefined : eq(accessPolicies.permissionKey, permissionKey);
    const rows = await this.db
      .select()
      .from(accessPolicies)
      .where(where)
      .orderBy(accessPolicies.priority, accessPolicies.createdAt);
    return rows.map((row) => this.toPolicyMatch(row));
  }

  private toPolicyMatch(row: AccessPolicyRow): PolicyMatch {
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      permissionKey: row.permissionKey,
      condition: row.condition,
      effect: row.effect,
      priority: row.priority,
      isEnabled: row.isEnabled,
    };
  }

  // ---- Roles & permission catalog management ----

  async listPermissions(): Promise<PermissionRow[]> {
    return await this.db.select().from(permissions).orderBy(permissions.resource, permissions.action);
  }

  async listRoles(): Promise<RoleWithGrants[]> {
    const roleRows = await this.db.select().from(roles).orderBy(roles.priority, roles.name);
    const rows: RoleWithGrants[] = roleRows.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      priority: r.priority,
      isSystem: r.isSystem,
      isActive: r.isActive,
      isStaff: r.isStaff,
      grants: [],
    }));

    if (roleRows.length === 0) return rows;

    const roleIds = roleRows.map((r) => r.id);
    const grantRows = await this.db
      .select({
        roleId: rolePermissions.roleId,
        permissionKey: permissions.key,
        effect: rolePermissions.effect,
      })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(inArray(rolePermissions.roleId, roleIds));

    const byRole = new Map<string, { permissionKey: string; effect: GrantEffect }[]>();
    for (const grant of grantRows) {
      const bucket = byRole.get(grant.roleId) ?? [];
      bucket.push({ permissionKey: grant.permissionKey, effect: grant.effect });
      byRole.set(grant.roleId, bucket);
    }
    for (const role of rows) {
      role.grants = byRole.get(role.id) ?? [];
    }
    return rows;
  }

  async upsertPermissionsFromCatalog(entries: { key: string; resource: string; action: string; category: string; description: string }[]): Promise<void> {
    for (const entry of entries) {
      const existingRows = await this.db
        .select({ id: permissions.id })
        .from(permissions)
        .where(eq(permissions.key, entry.key))
        .limit(1);
      const existing = existingRows.at(0) ?? null;
      if (existing) {
        await this.db
          .update(permissions)
          .set({
            resource: entry.resource,
            action: entry.action,
            category: entry.category,
            description: entry.description,
            updatedAt: new Date(),
          })
          .where(eq(permissions.id, existing.id));
      } else {
        await this.db.insert(permissions).values(entry);
      }
    }
  }

  async findRoleByKey(key: string): Promise<RoleRow | null> {
    const rows = await this.db.select().from(roles).where(eq(roles.key, key)).limit(1);
    return rows.at(0) ?? null;
  }

  async findRoleById(id: string): Promise<RoleRow | null> {
    const rows = await this.db.select().from(roles).where(eq(roles.id, id)).limit(1);
    return rows.at(0) ?? null;
  }

  async createRole(input: { key: string; name: string; description?: string; priority?: number; isSystem?: boolean; isStaff?: boolean }) {
    const key = input.key.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (key === '') throw new Error('Role key is required');
    const rows = await this.db
      .insert(roles)
      .values({
        key,
        name: input.name.trim(),
        description: input.description?.trim() ?? '',
        priority: input.priority ?? 100,
        isSystem: input.isSystem ?? false,
        isStaff: input.isStaff ?? false,
      })
      .returning();
    return rows.at(0) ?? null;
  }

  async updateRole(id: string, input: Partial<{ name: string; description: string; priority: number; isActive: boolean; isStaff: boolean }>) {
    const rows = await this.db
      .update(roles)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(roles.id, id))
      .returning();
    return rows.at(0) ?? null;
  }

  async deleteRole(id: string): Promise<boolean> {
    const rows = await this.db
      .select({ isSystem: roles.isSystem, key: roles.key, priority: roles.priority })
      .from(roles)
      .where(eq(roles.id, id))
      .limit(1);
    const row = rows.at(0) ?? null;
    if (!row) return false;
    if (row.isSystem) throw new Error(`System role '${row.key}' cannot be deleted`);
    if (row.priority < 100) throw new Error(`Built-in role '${row.key}' cannot be deleted`);
    await this.db.delete(roles).where(eq(roles.id, id));
    return true;
  }

/** Replace a role's entire permission grant set. */
  async countRolePermissions(roleId: string): Promise<number> {
    const rows = await this.db
      .select({ id: rolePermissions.id })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, roleId))
      .limit(1);
    return rows.length;
  }

  async setRolePermissions(roleId: string, grants: { permissionKey: string; effect: GrantEffect }[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
      if (grants.length === 0) return;
      const keys = grants.map((g) => g.permissionKey);
      const permRows = await tx.select().from(permissions).where(inArray(permissions.key, keys));
      const permIdByKey = new Map(permRows.map((p) => [p.key, p.id]));
      const values = [];
      for (const grant of grants) {
        const permissionId = permIdByKey.get(grant.permissionKey);
        if (permissionId !== undefined) values.push({ roleId, permissionId, effect: grant.effect });
      }
      if (values.length > 0) await tx.insert(rolePermissions).values(values);
    });
  }

  /** User ids that hold a given role (directly or via user_roles) — for cache invalidation. */
  async listUserIdsByRoleKey(roleKey: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.key, roleKey))
      .limit(1);
    const role = rows.at(0) ?? null;
    if (!role) return [];

    const primary = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, roleKey));
    const extra = await this.db
      .select({ id: userRoles.userId })
      .from(userRoles)
      .where(eq(userRoles.roleId, role.id));

    const ids = new Set<string>();
    for (const row of primary) ids.add(row.id);
    for (const row of extra) ids.add(row.id);
    return [...ids];
  }

  // ---- ABAC policy management ----

  async createPolicy(input: {
    key: string;
    name: string;
    permissionKey: string;
    description?: string;
    condition: Record<string, unknown>;
    effect: GrantEffect;
    priority: number;
    createdBy?: string | null;
  }): Promise<AccessPolicyRow | null> {
    if (!isPermissionKey(input.permissionKey)) {
      throw new Error(`Unknown permission '${input.permissionKey}'`);
    }
    const key = input.key.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (key === '') throw new Error('Policy key is required');
    const rows = await this.db
      .insert(accessPolicies)
      .values({
        key,
        name: input.name.trim(),
        permissionKey: input.permissionKey,
        description: input.description?.trim() ?? '',
        condition: input.condition,
        effect: input.effect,
        priority: input.priority,
        createdBy: input.createdBy ?? null,
      })
      .returning();
    return rows.at(0) ?? null;
  }

  async updatePolicy(
    id: string,
    input: Partial<{
      name: string;
      permissionKey: string;
      description: string;
      condition: Record<string, unknown>;
      effect: GrantEffect;
      priority: number;
      isEnabled: boolean;
    }>,
  ): Promise<AccessPolicyRow | null> {
    if (input.permissionKey !== undefined && !isPermissionKey(input.permissionKey)) {
      throw new Error(`Unknown permission '${input.permissionKey}'`);
    }
    const rows = await this.db
      .update(accessPolicies)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(accessPolicies.id, id))
      .returning();
    return rows.at(0) ?? null;
  }

  async deletePolicy(id: string): Promise<boolean> {
    const rows = await this.db.delete(accessPolicies).where(eq(accessPolicies.id, id)).returning();
    return rows.at(0) !== undefined;
  }

  // ---- Audit trail ----

  async insertAudit(entry: Omit<AuditLogInsert, 'id' | 'createdAt'>): Promise<void> {
    await this.db.insert(auditLogs).values(entry);
  }

  async listAudits(limit = 100): Promise<AuditLogRow[]> {
    const rows = await this.db
      .select()
      .from(auditLogs)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
    return rows;
  }
}