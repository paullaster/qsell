import { ALL_PERMISSION_KEYS, PERMISSIONS, type PermissionKey } from './permissions';
import type { AccessControlRepository, GrantEffect } from './repository';

interface SeedRole {
  key: string;
  name: string;
  description: string;
  priority: number;
  isSystem: boolean;
  isStaff: boolean;
  grants: (PermissionKey | { key: PermissionKey; effect: GrantEffect })[];
}

const READ_PERMISSIONS = ALL_PERMISSION_KEYS.filter((key) => key.endsWith(':read'));

const SEED_ROLES: SeedRole[] = [
  {
    key: 'super_admin',
    name: 'Super Admin',
    description: 'Full, unconditional access across the entire application.',
    priority: 0,
    isSystem: true,
    isStaff: true,
    grants: ALL_PERMISSION_KEYS,
  },
  {
    key: 'admin',
    name: 'Administrator',
    description: 'Day-to-day business + configuration control, without security administration.',
    priority: 100,
    isSystem: true,
    isStaff: true,
    grants: [
      ...READ_PERMISSIONS,
      'reports:all_branches',
      'orders:create',
      'orders:update',
      'orders:approve',
      'orders:cancel',
      'orders:export',
      'quotes:create',
      'quotes:update',
      'quotes:approve',
      'quotes:delete',
      'projects:create',
      'projects:update',
      'projects:open',
      'projects:hold',
      'projects:complete',
      'projects:close',
      'projects:cancel',
      'customers:create',
      'customers:update',
      'customers:delete',
      'customers:import',
      'customers:export',
      'products:create',
      'products:update',
      'products:delete',
      'products:delete_permanently',
      'products:adjust_stock',
      'inventory:adjust',
      'media:upload',
      'media:delete',
      'payments:refund',
      'transactions:post',
      'transactions:reconcile',
      'transactions:export',
      'taxes:manage',
      'credit_notes:create',
      'numbering:manage',
      'approvals:manage',
      'approvals:act',
      'approvals:request',
      'pricing:manage',
      'currencies:manage',
      'branches:manage',
      'dimensions:manage',
      'company:manage',
      'settings:manage',
      'analytics:export',
    ],
  },
  {
    key: 'manager',
    name: 'Manager',
    description: 'Operational control over orders, customers, inventory, and payments.',
    priority: 200,
    isSystem: false,
    isStaff: true,
    grants: [
      // Managers see operations; product costs (profit) are an owner/admin decision.
      ...READ_PERMISSIONS.filter((key) => key !== 'report_profit:read'),
      'orders:create',
      'orders:update',
      'orders:cancel',
      'orders:approve',
      'quotes:create',
      'quotes:update',
      'quotes:approve',
      'projects:create',
      'projects:update',
      'projects:open',
      'projects:hold',
      'projects:complete',
      'approvals:act',
      'approvals:request',
      'customers:create',
      'customers:update',
      'customers:import',
      'products:update',
      'products:adjust_stock',
      'inventory:adjust',
      'media:upload',
      'payments:read',
      'payments:refund',
      'transactions:read',
      'transactions:post',
      'analytics:read',
    ],
  },
  {
    key: 'customer',
    name: 'Customer',
    description: 'Limited self-service access for customer-store users.',
    priority: 1000,
    isSystem: false,
    isStaff: false,
    grants: ['dashboard:read'],
  },
];

interface SeedResult {
  rolesCreated: string[];
  permissionsSynced: number;
}

/**
 * Idempotent bootstrap. Permission catalog is synced on every boot (it is the
 * code-level source of truth); role bindings are only written when a role is
 * first created so admins can safely customize them afterwards.
 */
export async function seedAccessControl(repo: AccessControlRepository): Promise<SeedResult> {
  return await repo.runExclusive(seedWithin);
}

async function seedWithin(repo: AccessControlRepository): Promise<SeedResult> {
  const catalog = ALL_PERMISSION_KEYS.map((key) => {
    const meta = PERMISSIONS[key];
    return {
      key,
      resource: meta.resource,
      action: meta.action,
      category: meta.category,
      description: meta.description,
    };
  });

  await repo.upsertPermissionsFromCatalog(catalog);

  const rolesCreated: string[] = [];
  for (const seed of SEED_ROLES) {
    const existing = await repo.findRoleByKey(seed.key);
    const role =
      existing ??
      (await repo.createRole({
        key: seed.key,
        name: seed.name,
        description: seed.description,
        priority: seed.priority,
        isSystem: seed.isSystem,
        isStaff: seed.isStaff,
      }));
    if (!role) throw new Error(`Failed to create role '${seed.key}'`);
    if (!existing) rolesCreated.push(seed.key);

    // De-duplicated by key: role_permissions is unique per (role, permission), so a
    // repeated key (e.g. one already in READ_PERMISSIONS) used to fail the whole
    // insert and leave the role with no permissions at all.
    const grantByKey = new Map<string, { permissionKey: string; effect: GrantEffect }>();
    for (const grant of seed.grants) {
      const entry =
        typeof grant === 'string'
          ? { permissionKey: grant, effect: 'allow' as const }
          : { permissionKey: grant.key, effect: grant.effect };
      grantByKey.set(entry.permissionKey, entry);
    }
    const grants = [...grantByKey.values()];

    // super_admin is a security invariant: full access is re-asserted on every
    // boot so the role can never be partially locked down (fine-grained grants
    // written at creation only for other roles so admins can customize).
    if (seed.key === 'super_admin') {
      await repo.setRolePermissions(
        role.id,
        ALL_PERMISSION_KEYS.map((key) => ({ permissionKey: key, effect: 'allow' as const })),
      );
    } else if (!existing) {
      await repo.setRolePermissions(role.id, grants);
    } else if ((await repo.countRolePermissions(role.id)) === 0) {
      // Repair: an earlier seed bug (a duplicate grant) aborted the insert and left
      // this role with no permissions. A role with zero bindings is never a useful
      // customization (roles are switched off via isActive), so restore defaults.
      console.warn(`[access-control] role '${seed.key}' had no permissions; restoring defaults`);
      await repo.setRolePermissions(role.id, grants);
    }
  }

  return { rolesCreated, permissionsSynced: catalog.length };
}
