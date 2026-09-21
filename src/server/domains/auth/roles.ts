/** Application roles. super_admin is env-seeded and has full system power. */
export const APP_ROLES = ['super_admin', 'admin', 'manager', 'customer'] as const;
export type AppRole = (typeof APP_ROLES)[number];

export function isSuperAdminRole(role: string | null | undefined): boolean {
  return role === 'super_admin';
}

/** Roles that may access /admin and staff surfaces. */
export function isStaffRole(role: string | null | undefined): boolean {
  return role === 'super_admin' || role === 'admin' || role === 'manager';
}

/** Full platform control (dimensions, payments secrets, user admin, etc.). */
export function hasFullSystemPower(role: string | null | undefined): boolean {
  return role === 'super_admin';
}
