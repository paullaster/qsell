'use client';

import type { PermissionKey } from '@/server/domains/access-control/permissions';
import type { DirectGrantInput } from '@/server/domains/users/repository';
import type { GrantValue } from './PermissionMatrix';

/** Map stored direct grants to matrix state. */
export function grantListToState(
  grants: DirectGrantInput[],
): Partial<Record<PermissionKey, GrantValue>> {
  const state: Partial<Record<PermissionKey, GrantValue>> = {};
  for (const grant of grants) {
    state[grant.permissionKey as PermissionKey] = grant.effect;
  }
  return state;
}

/** Map matrix state back to persisted direct grants (empty for unset). */
export function stateToGrants(
  state: Partial<Record<PermissionKey, GrantValue>>,
): DirectGrantInput[] {
  const grants: DirectGrantInput[] = [];
  for (const [key, effect] of Object.entries(state)) {
    if (effect === null) continue;
    grants.push({ permissionKey: key, effect, branchId: null });
  }
  return grants;
}