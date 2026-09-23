import { ALL_PERMISSION_KEYS, PERMISSIONS, type PermissionKey } from './permissions';
import type { AccessControlRepository, GrantEffect } from './repository';

interface SeedRole {
  key: string;
  name: string;
  description: string;
  priority: number;
  isSystem: boolean;
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
    grants: ALL_PERMISSION_KEYS,
  },
  {
    key: 'admin',
    name: 'Administrator',
    description: 'Day-to-day business + configuration control, without security administration.',
    priority: 100,
    isSystem: true,
    grants: [
      ...READ_PERMISSIONS,
      'orders:create',
      'orders:update',
      'orders:approve',
      'orders:cancel',
      'orders:export',
      'quotes:create',
      'quotes:update',
      'quotes:approve',
      'quotes:delete',
      'customers:create',
      'customers:update',
      'customers:delete',
      'customers:import',
      'customers:export',
      'products:create',
      'products:update',
      'products:delete',
      'products:adjust_stock',
      'inventory:adjust',
      'payments:refund',
      'transactions:post',
      'transactions:reconcile',
      'transactions:export',
      'taxes:manage',
      'currencies:manage',
      'branches:manage',
      'dimensions:manage',
      'company:manage',
      'settings:manage',
      'audits:read',
      'analytics:export',
    ],
  },
  {
    key: 'manager',
    name: 'Manager',
    description: 'Operational control over orders, customers, inventory, and payments.',
    priority: 200,
    isSystem: false,
    grants: [
      ...READ_PERMISSIONS,
      'orders:create',
      'orders:update',
      'orders:cancel',
      'orders:approve',
      'quotes:create',
      'quotes:update',
      'quotes:approve',
      'customers:create',
      'customers:update',
      'customers:import',
      'products:update',
      'products:adjust_stock',
      'inventory:adjust',
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
      }));
    if (!role) throw new Error(`Failed to create role '${seed.key}'`);
    if (!existing) rolesCreated.push(seed.key);

    const grants = seed.grants.map((grant) =>
      typeof grant === 'string'
        ? { permissionKey: grant, effect: 'allow' as const }
        : { permissionKey: grant.key, effect: grant.effect },
    );

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
    }
  }

  return { rolesCreated, permissionsSynced: catalog.length };
}