import { describe, expect, it } from 'vitest';
import { firstPackageOnly, packageOnlyProblem, packageOnlyRefusal } from './package-only';

describe('packageOnlyProblem', () => {
  it('has nothing to say about an ordinary product', () => {
    expect(packageOnlyProblem({ soldOnlyInPackages: false, isCheckoutPackaging: true, isSellable: false })).toBeNull();
  });
  it('allows a sellable product that is not checkout packaging', () => {
    expect(packageOnlyProblem({ soldOnlyInPackages: true, isCheckoutPackaging: false, isSellable: true })).toBeNull();
  });
  it('refuses checkout packaging, and a product that cannot be priced', () => {
    expect(packageOnlyProblem({ soldOnlyInPackages: true, isCheckoutPackaging: true, isSellable: true })).toMatch(/checkout packaging/);
    expect(packageOnlyProblem({ soldOnlyInPackages: true, isCheckoutPackaging: false, isSellable: false })).toMatch(/sellable item type/);
  });
});

describe('packageOnlyRefusal and firstPackageOnly', () => {
  it('names the product in plain words', () => {
    expect(packageOnlyRefusal('Brown ugali')).toBe('Brown ugali is sold only as part of a package and cannot be ordered on its own.');
  });
  it('finds the package-only product among several', () => {
    const list: { id: string; soldOnlyInPackages?: boolean }[] = [{ id: 'a' }, { id: 'b', soldOnlyInPackages: true }, { id: 'c', soldOnlyInPackages: false }];
    expect(firstPackageOnly(list)?.id).toBe('b');
    expect(firstPackageOnly<{ id: string; soldOnlyInPackages?: boolean }>([{ id: 'a' }, undefined])).toBeUndefined();
  });
});
