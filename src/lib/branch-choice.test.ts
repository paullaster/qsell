import { describe, expect, it } from 'vitest';
import { chooseBranch, choiceWords, type BranchOption } from './branch-choice';

const branch = (code: string, km: number | null, over: Partial<BranchOption> = {}): BranchOption => ({
  branchId: `id-${code}`, code, name: `Branch ${code}`, km, minutes: null, coversLines: 3, totalLines: 3, coversUnits: 10, totalUnits: 10, offersMethod: true, ...over,
});
const none = { coversLines: 0, coversUnits: 0 };
const some = (lines: number, units: number) => ({ coversLines: lines, coversUnits: units });

describe('chooseBranch', () => {
  it('takes the nearest branch that has all of it', () => {
    const r = chooseBranch([branch('B', 9), branch('A', 4), branch('C', 2, some(2, 8))], true);
    expect(r.chosen?.code).toBe('A');
    expect(r.reason).toBe('nearer_lacked_stock');
    expect(r.passedOver).toEqual(['C']);
    expect(r.partial).toBe(false);
    expect(choiceWords(r)).toBe('Branch A (4 km away) is the nearest branch that has all of it; C is nearer but cannot cover the whole order.');
  });

  it('says plainly when the nearest branch is the one chosen', () => {
    const r = chooseBranch([branch('A', 2), branch('B', 5)], true);
    expect(r.reason).toBe('nearest_covers_all');
    expect(r.passedOver).toEqual([]);
    expect(choiceWords(r)).toBe('Branch A is the nearest branch (2 km away) and has all of it.');
  });

  it('is the same whatever order the branches come in, and ties go to the code', () => {
    const list = [branch('C', 3), branch('A', 3), branch('B', 3)];
    for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0]]) {
      expect(chooseBranch(order.map((i) => list[i] ?? branch('x', 1)), true).chosen?.code).toBe('A');
    }
  });

  it('when none has it all, takes the one that holds the most, then the nearest', () => {
    const r = chooseBranch([branch('A', 1, some(1, 3)), branch('B', 8, some(2, 4)), branch('C', 5, some(2, 4)), branch('D', 2, some(2, 2))], true);
    expect(r.chosen?.code).toBe('C');
    expect(r.reason).toBe('best_cover');
    expect(r.partial).toBe(true);
    expect(choiceWords(r)).toMatch(/No branch has all of it\. Branch C \(5 km away\) holds the most \(2 of 3 lines\)/);
  });

  it('leaves out a branch that does not offer the method, has no pin, or holds none of it, and says so', () => {
    const r = chooseBranch([branch('A', 1, { offersMethod: false }), branch('B', null), branch('C', 2, none), branch('D', 6)], true);
    expect(r.chosen?.code).toBe('D');
    expect(r.reason).toBe('only_candidate');
    expect(r.excluded).toEqual([
      { branchId: 'id-A', code: 'A', why: 'method_not_offered' },
      { branchId: 'id-B', code: 'B', why: 'no_pin' },
      { branchId: 'id-C', code: 'C', why: 'holds_none_of_it' },
    ]);
  });

  it('refuses when nobody can deliver', () => {
    const r = chooseBranch([branch('A', null), branch('B', 3, { offersMethod: false })], true);
    expect(r).toMatchObject({ chosen: null, reason: 'no_branch' });
    expect(choiceWords(r)).toBe('No branch can deliver this order.');
    expect(chooseBranch([], true).chosen).toBeNull();
  });

  it('without the customer’s position chooses by what a branch holds, never by distance, and does not need pins', () => {
    const r = chooseBranch([branch('B', null), branch('A', null, some(2, 5)), branch('C', null)], false);
    expect(r.chosen?.code).toBe('B');
    expect(r.reason).toBe('position_unknown');
    expect(r.excluded).toEqual([]);
    expect(choiceWords(r)).toMatch(/position is not known/);
  });

  it('an order of nothing is covered by every branch and goes to the nearest', () => {
    const empty = { totalLines: 0, totalUnits: 0, coversLines: 0, coversUnits: 0 };
    expect(chooseBranch([branch('A', 5, empty), branch('B', 2, empty)], true).chosen?.code).toBe('B');
  });
});
