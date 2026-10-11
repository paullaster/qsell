import type { GrantEffect, PermissionGrant } from './repository';

export interface ResolvedGrant {
  effect: GrantEffect;
  source: 'direct' | 'role';
  roleKey: string | null;
}

/**
 * Resolve the effective RBAC decision for one permission from a user's grants.
 *
 * Precedence (documented rules):
 *   1. A direct (per-user) grant beats every role grant for that permission.
 *      If a user somehow holds both a direct allow and deny, deny wins (fail safe).
 *   2. Among roles, the grant on the role with the SMALLEST priority number wins
 *      (role A priority 100 beats role B priority 200). Only the colliding
 *      permission is affected; non-colliding permissions from both roles still apply.
 *   3. Equal-priority roles that disagree resolve to deny (fail safe).
 *
 * Returns null when no grant mentions the permission (the caller falls through to ABAC).
 * `inScope` filters branch-scoped grants before precedence is applied.
 */
export function resolveGrant(
  grants: readonly PermissionGrant[],
  permissionKey: string,
  inScope: (branchId: string | null) => boolean,
): ResolvedGrant | null {
  let direct: ResolvedGrant | null = null;
  let role: (ResolvedGrant & { priority: number }) | null = null;

  for (const g of grants) {
    if (g.permissionKey !== permissionKey || !inScope(g.scopeBranchId)) continue;
    if (g.source === 'direct') {
      if (direct === null || g.effect === 'deny') {
        direct = { effect: g.effect, source: 'direct', roleKey: null };
      }
      continue;
    }
    if (
      role === null ||
      g.rolePriority < role.priority ||
      (g.rolePriority === role.priority && g.effect === 'deny' && role.effect === 'allow')
    ) {
      role = { effect: g.effect, source: 'role', roleKey: g.roleKey, priority: g.rolePriority };
    }
  }

  if (direct !== null) return direct;
  if (role !== null) return { effect: role.effect, source: 'role', roleKey: role.roleKey };
  return null;
}
