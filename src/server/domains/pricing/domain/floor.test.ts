import { describe, expect, it } from 'vitest';
import { describeRule, limitFor, reductionPercent, resolveFloor, shortfallPercent } from './floor';
import type { FloorProduct, FloorRule } from './types';

const rule = (
  scopeType: FloorRule['scopeType'],
  scopeRef: string,
  markupPercent: number,
  enforcement: FloorRule['enforcement'] = 'approval',
): FloorRule => ({
  id: `${scopeType}:${scopeRef}`,
  scopeType,
  scopeRef,
  markupPercent,
  enforcement,
});

const product = (over: Partial<FloorProduct> = {}): FloorProduct => ({
  id: 'p1',
  costPrice: 100,
  brand: 'Acme',
  categoryChain: ['running', 'shoes'],
  groupIds: [],
  ...over,
});

describe('floor resolution', () => {
  it('is cost plus the markup', () => {
    const r = resolveFloor(product(), [rule('default', '', 10)]);
    expect(r.floorNet).toBe(110);
  });

  it('prefers the product, then a group or brand, then the nearest category, then the default', () => {
    const all = [
      rule('default', '', 5),
      rule('category', 'shoes', 10),
      rule('category', 'running', 15),
      rule('brand', 'acme', 20),
      rule('product_group', 'g1', 25),
      rule('product', 'p1', 30),
    ];
    expect(resolveFloor(product({ groupIds: ['g1'] }), all).rule?.scopeType).toBe('product');
    expect(resolveFloor(product({ id: 'p2', groupIds: ['g1'] }), all).rule?.markupPercent).toBe(25);
    expect(resolveFloor(product({ id: 'p2' }), all).rule?.scopeType).toBe('brand');
    expect(resolveFloor(product({ id: 'p2', brand: null }), all).rule?.markupPercent).toBe(15);
    expect(
      resolveFloor(product({ id: 'p2', brand: null, categoryChain: ['shoes'] }), all).rule
        ?.markupPercent,
    ).toBe(10);
    expect(
      resolveFloor(product({ id: 'p2', brand: null, categoryChain: [] }), all).rule?.scopeType,
    ).toBe('default');
  });

  it('a sub-category rule beats its parent, whatever order the rules come in', () => {
    const rules = [rule('category', 'shoes', 10), rule('category', 'running', 15)];
    expect(resolveFloor(product({ brand: null }), rules).rule?.scopeRef).toBe('running');
    expect(resolveFloor(product({ brand: null }), [...rules].reverse()).rule?.scopeRef).toBe(
      'running',
    );
  });

  it('takes the strictest of several groups and brand, so no group floor is undercut', () => {
    const rules = [
      rule('product_group', 'g1', 12),
      rule('product_group', 'g2', 18),
      rule('brand', 'Acme', 15),
    ];
    const r = resolveFloor(product({ groupIds: ['g1', 'g2'] }), rules);
    expect(r.rule?.markupPercent).toBe(18);
  });

  it('matches a brand without regard to case or spaces around it', () => {
    expect(
      resolveFloor(product({ brand: '  ACME ' }), [rule('brand', 'acme', 9)]).rule?.markupPercent,
    ).toBe(9);
  });

  it('gives no floor, and says why, when the cost is unknown', () => {
    const r = resolveFloor(product({ costPrice: 0 }), [rule('default', '', 10)]);
    expect(r.floorNet).toBeNull();
    expect(r.rule).not.toBeNull();
    expect(r.note).toContain('no cost');
  });

  it('gives no floor when no rule applies', () => {
    expect(resolveFloor(product(), [rule('category', 'other', 10)])).toMatchObject({
      floorNet: null,
      rule: null,
    });
  });

  it('a zero markup means "not below cost"', () => {
    expect(resolveFloor(product(), [rule('default', '', 0)]).floorNet).toBe(100);
  });
});

describe('shortfall and reduction', () => {
  it('measures how far under the floor a price is', () => {
    expect(shortfallPercent(99, 110)).toBe(10);
    expect(shortfallPercent(110, 110)).toBe(0);
    expect(shortfallPercent(120, 110)).toBe(0);
  });
  it('measures how far a price was taken below the list price', () => {
    expect(reductionPercent(90, 100)).toBe(10);
    expect(reductionPercent(100, 100)).toBe(0);
    expect(reductionPercent(110, 100)).toBe(0);
    expect(reductionPercent(5, 0)).toBe(0);
  });
});

describe('override limits', () => {
  const limits = [
    { roleKey: 'sales', maxPercent: 5 },
    { roleKey: 'manager', maxPercent: 15 },
    { roleKey: '*', maxPercent: 2 },
  ];
  it("uses the most generous limit among a person's roles", () => {
    expect(limitFor(['sales', 'manager'], limits, false)).toBe(15);
    expect(limitFor(['sales'], limits, false)).toBe(5);
  });
  it('falls back to the default, and to no limit when there is none', () => {
    expect(limitFor(['clerk'], limits, false)).toBe(2);
    expect(limitFor(['clerk'], [{ roleKey: 'sales', maxPercent: 5 }], false)).toBeNull();
  });
  it('no limits configured, or a super admin, means no limit', () => {
    expect(limitFor(['sales'], [], false)).toBeNull();
    expect(limitFor(['sales'], limits, true)).toBeNull();
  });
});

describe('describing a rule', () => {
  it('says where the floor came from', () => {
    expect(describeRule(rule('brand', 'Acme', 12))).toBe('Brand Acme: cost + 12%');
    expect(describeRule(rule('category', 'c1', 8), { c1: 'Shoes' })).toBe(
      'Category Shoes: cost + 8%',
    );
    expect(describeRule(rule('default', '', 5))).toBe('The company default: cost + 5%');
  });
});
