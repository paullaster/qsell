import { and, count, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import { hash } from '@node-rs/bcrypt';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  permissions,
  roles,
  userPermissions,
  userRoles,
  users,
  type RoleRow,
  type UserRow,
} from '@/server/db/drizzle/schema';
import type { GrantEffect } from '@/server/domains/access-control/repository';

/** A drizzle transaction handle — same row-typed API as the root database. */
type DbOrTx = DrizzleDb | Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface UserListEntry {
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
  updatedAt: Date;
  /** Additional role keys (user_roles) beyond the primary users.role. */
  extraRoles: string[];
}

export interface UserListResult {
  rows: UserListEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RoleAssignment {
  roleKey: string;
  branchId?: string | null;
}

export interface DirectGrantInput {
  permissionKey: string;
  effect: GrantEffect;
  branchId?: string | null;
  expiresAt?: Date | null;
}

export interface CreateUserInput {
  email: string;
  password: string;
  name: string;
  title?: string | null;
  phone?: string | null;
  role: string;
  status?: 'active' | 'suspended';
  branchId?: string | null;
  customerStoreId?: string | null;
  extraRoles?: RoleAssignment[];
  directGrants?: DirectGrantInput[];
}

export interface UpdateUserInput {
  name?: string;
  title?: string | null;
  phone?: string | null;
  role?: string;
  status?: 'active' | 'suspended';
  branchId?: string | null;
  isActive?: boolean;
}

const EXTRA_ROLES_SQL = sql<string>`(
  select coalesce(json_agg(r.key), '[]'::json)
  from user_roles ur
  join roles r on r.id = ur.role_id
  where ur.user_id = users.id
)`;

export class UsersAdminRepository {
  constructor(private readonly db: DrizzleDb) {}

  /** Only the provisioned super-admin has canViewSuperAdmin=true. */
  async canViewSuperAdmins(userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ canViewSuperAdmin: users.canViewSuperAdmin })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const row = rows.at(0) ?? null;
    return row?.canViewSuperAdmin === true;
  }

  async listUsers(input: {
    search?: string;
    role?: string;
    status?: string;
    branchId?: string;
    page?: number;
    pageSize?: number;
    /** Hide primary super-admin accounts (caller lacks canViewSuperAdmin). */
    hideSuperAdmins?: boolean;
  }): Promise<UserListResult> {
    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 25));

    const conditions = [];
    if (input.hideSuperAdmins === true) conditions.push(ne(users.role, 'super_admin'));
    if (input.search !== undefined && input.search !== '') {
      const term = `%${input.search.trim()}%`;
      conditions.push(or(ilike(users.name, term), ilike(users.email, term)));
    }
    if (input.role !== undefined) conditions.push(eq(users.role, input.role));
    if (input.status !== undefined) conditions.push(eq(users.status, input.status));
    if (input.branchId !== undefined) conditions.push(eq(users.branchId, input.branchId));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [{ total }] = await this.db
      .select({ total: count() })
      .from(users)
      .where(where);

    const rows = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        title: users.title,
        phone: users.phone,
        role: users.role,
        status: users.status,
        branchId: users.branchId,
        isActive: users.isActive,
        mustChangePassword: users.mustChangePassword,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
        extraRoles: EXTRA_ROLES_SQL,
      })
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt), desc(users.updatedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const parsed = rows.map((row) => ({ ...row, extraRoles: parseRoleKeys(row.extraRoles) }));
    return { rows: parsed, total, page, pageSize };
  }

  async getUserDetail(id: string): Promise<{
    user: UserRow;
    extraRoles: RoleRow[];
    directGrants: DirectGrantInput[];
  } | null> {
    const userRows = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    const user = userRows.at(0) ?? null;
    if (!user) return null;

    const assignmentRows = await this.db
      .select({
        role: roles,
        branchId: userRoles.branchId,
      })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, id));

    const grantRows = await this.db
      .select({
        permissionKey: permissions.key,
        effect: userPermissions.effect,
        branchId: userPermissions.branchId,
        expiresAt: userPermissions.expiresAt,
      })
      .from(userPermissions)
      .innerJoin(permissions, eq(permissions.id, userPermissions.permissionId))
      .where(eq(userPermissions.userId, id));

    return {
      user,
      extraRoles: assignmentRows.map((r) => r.role),
      directGrants: grantRows.map((g) => ({
        permissionKey: g.permissionKey,
        effect: g.effect,
        branchId: g.branchId,
        expiresAt: g.expiresAt,
      })),
    };
  }

  async createUser(input: CreateUserInput): Promise<UserRow> {
    const email = input.email.trim().toLowerCase();
    const existingRows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    const existing = existingRows.at(0) ?? null;
    if (existing) throw new Error(`A user with email ${email} already exists`);

    const passwordHash = await hash(input.password, 12);

    return await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({
          email,
          passwordHash,
          name: input.name.trim(),
          title: input.title ?? null,
          phone: input.phone ?? null,
          role: input.role,
          status: input.status ?? 'active',
          branchId: input.branchId ?? null,
          customerStoreId: input.customerStoreId ?? null,
          // The admin knows this password, so the owner must replace it at first sign-in.
          mustChangePassword: true,
          // Admin-provisioned accounts are vouched for; only self sign-ups must verify.
          emailVerifiedAt: new Date(),
          permissionsVersion: 0,
        })
        .returning();
      await applyRoleAssignments(tx, created.id, input.extraRoles ?? [], null);
      await applyDirectGrants(tx, created.id, input.directGrants ?? []);
      return created;
    });
  }

  async updateUser(id: string, input: UpdateUserInput): Promise<UserRow | null> {
    const patch: Partial<UserRow> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.title !== undefined) patch.title = input.title;
    if (input.phone !== undefined) patch.phone = input.phone;
    if (input.role !== undefined) patch.role = input.role;
    if (input.status !== undefined) patch.status = input.status;
    if (input.branchId !== undefined) patch.branchId = input.branchId;
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    const rows = await this.db
      .update(users)
      .set(patch)
      .where(eq(users.id, id))
      .returning();
    return rows.at(0) ?? null;
  }

  async deleteUser(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(users)
      .where(eq(users.id, id))
      .returning({ id: users.id });
    return rows.at(0) !== undefined;
  }

  /** Admin-set password: the admin knows it, so the owner must replace it at next sign-in. */
  async resetPassword(userId: string, newPassword: string): Promise<boolean> {
    const passwordHash = await hash(newPassword, 12);
    const rows = await this.db
      .update(users)
      .set({ passwordHash, mustChangePassword: true, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ id: users.id });
    return rows.at(0) !== undefined;
  }

  /** Replace the user's additional role assignments (user_roles). */
  async setExtraRoles(userId: string, assignments: RoleAssignment[], assignedBy: string | null): Promise<void> {
    await this.db.transaction(async (tx) => {
      await applyRoleAssignments(tx, userId, assignments, assignedBy);
    });
  }

  /** Replace the user's direct permission grants. */
  async setDirectGrants(userId: string, grants: DirectGrantInput[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await applyDirectGrants(tx, userId, grants);
    });
  }

  async countSuperAdmins(): Promise<number> {
    const [{ total }] = await this.db
      .select({ total: count() })
      .from(users)
      .where(eq(users.role, 'super_admin'));
    return total;
  }

  async listSuperAdminIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'super_admin'));
    return rows.map((r) => r.id);
  }
}

async function applyRoleAssignments(
  tx: DbOrTx,
  userId: string,
  assignments: RoleAssignment[],
  assignedBy: string | null,
): Promise<void> {
  await tx.delete(userRoles).where(eq(userRoles.userId, userId));
  if (assignments.length === 0) return;

  const keys = [...new Set(assignments.map((a) => a.roleKey))];
  const roleRows = await tx
    .select({ id: roles.id, key: roles.key })
    .from(roles)
    .where(and(inArray(roles.key, keys), eq(roles.isActive, true)));
  const roleIdByKey = new Map(roleRows.map((r) => [r.key, r.id]));

  const values = assignments.flatMap((assignment) => {
    const roleId = roleIdByKey.get(assignment.roleKey);
    return roleId !== undefined
      ? [{ userId, roleId, branchId: assignment.branchId ?? null, assignedBy }]
      : [];
  });
  if (values.length > 0) await tx.insert(userRoles).values(values);
}

async function applyDirectGrants(
  tx: DbOrTx,
  userId: string,
  grants: DirectGrantInput[],
): Promise<void> {
  await tx.delete(userPermissions).where(eq(userPermissions.userId, userId));
  if (grants.length === 0) return;

  const keys = grants.map((g) => g.permissionKey);
  const permRows = await tx
    .select({ id: permissions.id, key: permissions.key })
    .from(permissions)
    .where(inArray(permissions.key, keys));
  const permIdByKey = new Map(permRows.map((p) => [p.key, p.id]));

  const values = grants.flatMap((grant) => {
    const permissionId = permIdByKey.get(grant.permissionKey);
    return permissionId !== undefined
      ? [
          {
            userId,
            permissionId,
            effect: grant.effect,
            branchId: grant.branchId ?? null,
            expiresAt: grant.expiresAt ?? null,
          },
        ]
      : [];
  });
  if (values.length > 0) await tx.insert(userPermissions).values(values);
}

function parseRoleKeys(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

export type { RoleRow, UserRow, GrantEffect };