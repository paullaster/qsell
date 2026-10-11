import { describe, expect, it } from 'vitest';
import { resolveGrant } from './resolve';
import type { PermissionGrant } from './repository';

const any = () => true;
const role = (
  key: string,
  priority: number,
  effect: 'allow' | 'deny',
  perm = 'orders:update',
): PermissionGrant => ({
  permissionKey: perm,
  effect,
  source: 'role',
  scopeBranchId: null,
  roleKey: key,
  rolePriority: priority,
});
const direct = (effect: 'allow' | 'deny', perm = 'orders:update'): PermissionGrant => ({
  permissionKey: perm,
  effect,
  source: 'direct',
  scopeBranchId: null,
  roleKey: null,
  rolePriority: 0,
});

describe('resolveGrant', () => {
  it('returns null with no grant', () => {
    expect(resolveGrant([role('a', 100, 'allow', 'x:read')], 'orders:update', any)).toBeNull();
  });
  it('lowest priority number role wins a collision', () => {
    expect(
      resolveGrant([role('B', 200, 'allow'), role('A', 100, 'deny')], 'orders:update', any),
    ).toMatchObject({ effect: 'deny', roleKey: 'A' });
    expect(
      resolveGrant([role('A', 100, 'allow'), role('B', 200, 'deny')], 'orders:update', any),
    ).toMatchObject({ effect: 'allow', roleKey: 'A' });
  });
  it('does not let a collision on one permission affect another', () => {
    const grants = [
      role('A', 100, 'deny', 'orders:update'),
      role('B', 200, 'allow', 'orders:create'),
    ];
    expect(resolveGrant(grants, 'orders:create', any)?.effect).toBe('allow');
  });
  it('user grant beats any role grant', () => {
    expect(
      resolveGrant([role('A', 1, 'deny'), direct('allow')], 'orders:update', any),
    ).toMatchObject({ effect: 'allow', source: 'direct' });
    expect(
      resolveGrant([role('A', 1, 'allow'), direct('deny')], 'orders:update', any)?.effect,
    ).toBe('deny');
  });
  it('equal priority conflict denies', () => {
    expect(
      resolveGrant([role('A', 100, 'allow'), role('B', 100, 'deny')], 'orders:update', any)?.effect,
    ).toBe('deny');
  });
  it('ignores out-of-scope branch grants', () => {
    const g: PermissionGrant = { ...direct('deny'), scopeBranchId: 'b1' };
    expect(
      resolveGrant([g, role('A', 100, 'allow')], 'orders:update', (b) => b === null)?.effect,
    ).toBe('allow');
  });
});
