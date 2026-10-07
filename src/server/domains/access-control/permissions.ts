/**
 * The single source of truth for application permissions.
 *
 * This module is dependency-free so both server (engine, seeds, guards) and
 * admin client components can import it. Keys follow `<resource>:<action>`.
 * Adding a permission here is enough to make it available for role bindings,
 * direct grants, and ABAC policy conditions.
 */

export const PERMISSION_CATEGORIES = [
  'General',
  'Orders & Sales',
  'Customers',
  'Products & Inventory',
  'Finance & Payments',
  'Company & Settings',
  'Users & Access',
] as const;

export interface PermissionMeta {
  readonly resource: string;
  readonly action: string;
  readonly category: (typeof PERMISSION_CATEGORIES)[number];
  readonly description: string;
}

export const PERMISSIONS = {
  'dashboard:read': {
    resource: 'dashboard',
    action: 'read',
    category: 'General',
    description: 'View the business overview dashboard',
  },
  'analytics:read': {
    resource: 'analytics',
    action: 'read',
    category: 'General',
    description: 'View customer and sales analytics',
  },
  'analytics:export': {
    resource: 'analytics',
    action: 'export',
    category: 'General',
    description: 'Export analytics reports',
  },

  'orders:read': {
    resource: 'orders',
    action: 'read',
    category: 'Orders & Sales',
    description: 'View customer orders',
  },
  'orders:create': {
    resource: 'orders',
    action: 'create',
    category: 'Orders & Sales',
    description: 'Create orders on behalf of customers',
  },
  'orders:update': {
    resource: 'orders',
    action: 'update',
    category: 'Orders & Sales',
    description: 'Edit order details, status, and notes',
  },
  'orders:cancel': {
    resource: 'orders',
    action: 'cancel',
    category: 'Orders & Sales',
    description: 'Cancel orders and restock inventory',
  },
  'orders:delete': {
    resource: 'orders',
    action: 'delete',
    category: 'Orders & Sales',
    description: 'Delete orders',
  },
  'orders:approve': {
    resource: 'orders',
    action: 'approve',
    category: 'Orders & Sales',
    description: 'Approve credit orders',
  },
  'orders:export': {
    resource: 'orders',
    action: 'export',
    category: 'Orders & Sales',
    description: 'Export orders',
  },

  'quotes:read': {
    resource: 'quotes',
    action: 'read',
    category: 'Orders & Sales',
    description: 'View sales quotes',
  },
  'quotes:create': {
    resource: 'quotes',
    action: 'create',
    category: 'Orders & Sales',
    description: 'Create sales quotes',
  },
  'quotes:update': {
    resource: 'quotes',
    action: 'update',
    category: 'Orders & Sales',
    description: 'Edit sales quotes',
  },
  'quotes:approve': {
    resource: 'quotes',
    action: 'approve',
    category: 'Orders & Sales',
    description: 'Approve sales quotes for conversion to orders',
  },
  'quotes:delete': {
    resource: 'quotes',
    action: 'delete',
    category: 'Orders & Sales',
    description: 'Delete sales quotes',
  },

  'customers:read': {
    resource: 'customers',
    action: 'read',
    category: 'Customers',
    description: 'View customer accounts and profiles',
  },
  'customers:create': {
    resource: 'customers',
    action: 'create',
    category: 'Customers',
    description: 'Create customer accounts',
  },
  'customers:update': {
    resource: 'customers',
    action: 'update',
    category: 'Customers',
    description: 'Edit customer accounts',
  },
  'customers:delete': {
    resource: 'customers',
    action: 'delete',
    category: 'Customers',
    description: 'Delete customer accounts',
  },
  'customers:import': {
    resource: 'customers',
    action: 'import',
    category: 'Customers',
    description: 'Bulk import customers',
  },
  'customers:export': {
    resource: 'customers',
    action: 'export',
    category: 'Customers',
    description: 'Export customers',
  },

  'products:read': {
    resource: 'products',
    action: 'read',
    category: 'Products & Inventory',
    description: 'View products and categories',
  },
  'products:create': {
    resource: 'products',
    action: 'create',
    category: 'Products & Inventory',
    description: 'Create products',
  },
  'products:update': {
    resource: 'products',
    action: 'update',
    category: 'Products & Inventory',
    description: 'Edit products',
  },
  'products:delete': {
    resource: 'products',
    action: 'delete',
    category: 'Products & Inventory',
    description: 'Delete products',
  },
  'products:adjust_stock': {
    resource: 'products',
    action: 'adjust_stock',
    category: 'Products & Inventory',
    description: 'Adjust product stock levels',
  },
  'media:read': {
    resource: 'media',
    action: 'read',
    category: 'Products & Inventory',
    description: 'Browse the media library',
  },
  'media:upload': {
    resource: 'media',
    action: 'upload',
    category: 'Products & Inventory',
    description: 'Upload images and add image links to the media library',
  },
  'media:delete': {
    resource: 'media',
    action: 'delete',
    category: 'Products & Inventory',
    description: 'Delete media from the library',
  },
  'inventory:read': {
    resource: 'inventory',
    action: 'read',
    category: 'Products & Inventory',
    description: 'View inventory ledger and stock levels',
  },
  'inventory:adjust': {
    resource: 'inventory',
    action: 'adjust',
    category: 'Products & Inventory',
    description: 'Receive, write off, and audit stock',
  },

  'taxes:manage': {
    resource: 'taxes',
    action: 'manage',
    category: 'Finance & Payments',
    description: 'Manage tax categories and compliance schedules',
  },
  'credit_notes:create': {
    resource: 'credit_notes',
    action: 'create',
    category: 'Finance & Payments',
    description: 'Issue credit notes against tax invoices and retry their KRA signing',
  },
  'approvals:act': {
    resource: 'approvals',
    action: 'act',
    category: 'Orders & Sales',
    description: 'See the approvals waiting on you and approve or reject them',
  },
  'approvals:manage': {
    resource: 'approvals',
    action: 'manage',
    category: 'Company & Settings',
    description:
      'Design approval workflows, set approvers and limits, and switch approvals on or off',
  },
  'pricing:read': {
    resource: 'pricing',
    action: 'read',
    category: 'Orders & Sales',
    description: 'See price lists, customer groups and check how a price is worked out',
  },
  'pricing:manage': {
    resource: 'pricing',
    action: 'manage',
    category: 'Company & Settings',
    description: 'Create and change price lists and prices, customer groups and pricing rules',
  },
  'numbering:manage': {
    resource: 'numbering',
    action: 'manage',
    category: 'Company & Settings',
    description: 'Manage number series and which series numbers each document',
  },
  'currencies:manage': {
    resource: 'currencies',
    action: 'manage',
    category: 'Finance & Payments',
    description: 'Manage currencies and exchange rates',
  },
  'payments:read': {
    resource: 'payments',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View payments and attempts',
  },
  'payments:refund': {
    resource: 'payments',
    action: 'refund',
    category: 'Finance & Payments',
    description: 'Issue refunds',
  },
  'payments:manage_gateways': {
    resource: 'payments',
    action: 'manage_gateways',
    category: 'Finance & Payments',
    description: 'Configure payment gateways and providers',
  },
  'transactions:read': {
    resource: 'transactions',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View the transactions ledger',
  },
  'transactions:post': {
    resource: 'transactions',
    action: 'post',
    category: 'Finance & Payments',
    description: 'Post ledger entries',
  },
  'transactions:reconcile': {
    resource: 'transactions',
    action: 'reconcile',
    category: 'Finance & Payments',
    description: 'Reconcile payments and ledger lines',
  },
  'transactions:export': {
    resource: 'transactions',
    action: 'export',
    category: 'Finance & Payments',
    description: 'Export ledger transactions',
  },

  'branches:read': {
    resource: 'branches',
    action: 'read',
    category: 'Company & Settings',
    description: 'View branches',
  },
  'branches:manage': {
    resource: 'branches',
    action: 'manage',
    category: 'Company & Settings',
    description: 'Create and update branches',
  },
  'dimensions:manage': {
    resource: 'dimensions',
    action: 'manage',
    category: 'Company & Settings',
    description: 'Manage dimensions and their values',
  },
  'company:read': {
    resource: 'company',
    action: 'read',
    category: 'Company & Settings',
    description: 'View company setup',
  },
  'company:manage': {
    resource: 'company',
    action: 'manage',
    category: 'Company & Settings',
    description: 'Edit company profile, appearance, and modules',
  },
  'settings:read': {
    resource: 'settings',
    action: 'read',
    category: 'Company & Settings',
    description: 'View settings',
  },
  'settings:manage': {
    resource: 'settings',
    action: 'manage',
    category: 'Company & Settings',
    description: 'Change application settings',
  },

  'users:read': {
    resource: 'users',
    action: 'read',
    category: 'Users & Access',
    description: 'View user accounts',
  },
  'users:create': {
    resource: 'users',
    action: 'create',
    category: 'Users & Access',
    description: 'Create user accounts',
  },
  'users:update': {
    resource: 'users',
    action: 'update',
    category: 'Users & Access',
    description: 'Edit user profiles and status',
  },
  'users:delete': {
    resource: 'users',
    action: 'delete',
    category: 'Users & Access',
    description: 'Delete user accounts',
  },
  'users:manage_roles': {
    resource: 'users',
    action: 'manage_roles',
    category: 'Users & Access',
    description: 'Assign roles and direct permission grants',
  },
  'users:reset_password': {
    resource: 'users',
    action: 'reset_password',
    category: 'Users & Access',
    description: 'Reset user passwords',
  },
  'roles:read': {
    resource: 'roles',
    action: 'read',
    category: 'Users & Access',
    description: 'View roles and their permissions',
  },
  'roles:manage': {
    resource: 'roles',
    action: 'manage',
    category: 'Users & Access',
    description: 'Create roles and edit role permission bindings',
  },
  'policies:read': {
    resource: 'policies',
    action: 'read',
    category: 'Users & Access',
    description: 'View access policies',
  },
  'policies:manage': {
    resource: 'policies',
    action: 'manage',
    category: 'Users & Access',
    description: 'Create and edit ABAC access policies',
  },
  'audits:read': {
    resource: 'audits',
    action: 'read',
    category: 'Users & Access',
    description: 'View the security audit trail',
  },
  'audits:export': {
    resource: 'audits',
    action: 'export',
    category: 'Users & Access',
    description: 'Export the audit trail',
  },
} as const satisfies Record<string, PermissionMeta>;

export type PermissionKey = keyof typeof PERMISSIONS;

export const ALL_PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export function isPermissionKey(value: string): value is PermissionKey {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

/** Group permission keys by category for matrix rendering. */
export function groupPermissionsByCategory(
  keys: readonly PermissionKey[],
): { category: string; permissions: { key: PermissionKey; meta: PermissionMeta }[] }[] {
  const grouped = new Map<string, { key: PermissionKey; meta: PermissionMeta }[]>();
  for (const key of keys) {
    const meta = PERMISSIONS[key];
    const bucket = grouped.get(meta.category) ?? [];
    bucket.push({ key, meta });
    grouped.set(meta.category, bucket);
  }
  const order = PERMISSION_CATEGORIES;
  return order.flatMap((category) => {
    const items = grouped.get(category);
    return items
      ? [
          {
            category,
            permissions: items.sort((a, b) => a.meta.resource.localeCompare(b.meta.resource)),
          },
        ]
      : [];
  });
}
