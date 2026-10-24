/** Application roles. super_admin is env-seeded and has full system power. */
export const APP_ROLES = ['super_admin', 'admin', 'manager', 'customer', 'vendor'] as const;
export type AppRole = (typeof APP_ROLES)[number];

export function isSuperAdminRole(role: string | null | undefined): boolean {
  return role === 'super_admin';
}

/**
 * Roles that are staff even if their `roles` row is missing (e.g. before the access seed has run).
 * Everything else is decided by `roles.is_staff`; see UserRepository.isStaffRoleKey.
 */
export const BUILTIN_STAFF_ROLES: readonly string[] = ['super_admin', 'admin', 'manager'];

/** Full platform control (dimensions, payments secrets, user admin, etc.). */
export function hasFullSystemPower(role: string | null | undefined): boolean {
  return role === 'super_admin';
}
