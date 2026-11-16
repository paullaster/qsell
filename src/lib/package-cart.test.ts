import { describe, expect, it } from 'vitest';
import { addPackageLine, MAX_SERVINGS, packageBadgeCount, packageLine, parsePackageCart, removePackageLine, replacePackageLine, serializePackageCart, setPackageServings } from './package-cart';

const pick = (slotId: string, optionId: string, count = 1) => ({ slotId, optionId, count });
const a = packageLine('lunch', [pick('fish', 'small'), pick('starch', 'ugali')], 1);
const b = packageLine('lunch', [pick('fish', 'large'), pick('starch', 'ugali')], 2);

describe('package lines of the cart', () => {
  it('gives the same id to the same choices in any order', () => {
    expect(packageLine('lunch', [pick('starch', 'ugali'), pick('fish', 'small')], 1).id).toBe(a.id);
    expect(b.id).not.toBe(a.id);
  });
  it('joins equal choices into one line and keeps different choices apart', () => {
    const lines = addPackageLine(addPackageLine([], a), packageLine('lunch', [pick('starch', 'ugali'), pick('fish', 'small')], 2));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.servings).toBe(3);
    expect(addPackageLine(lines, b)).toHaveLength(2);
  });
  it('caps servings and drops zero counts', () => {
    expect(packageLine('p', [pick('s', 'o')], 5000).servings).toBe(MAX_SERVINGS);
    expect(packageLine('p', [pick('s', 'o', 0)], 1).picks).toEqual([]);
    expect(packageLine('p', [], 0).servings).toBe(1);
  });
  it('edits in place, and joins a line that becomes equal to another', () => {
    const lines = [a, b];
    const edited = replacePackageLine(lines, a.id, packageLine('lunch', [pick('fish', 'small'), pick('starch', 'brown')], 1));
    expect(edited.map((l) => l.id)).toEqual([edited[0]?.id, b.id]);
    expect(edited[0]?.picks[1]?.optionId).toBe('brown');
    const joined = replacePackageLine(lines, a.id, packageLine('lunch', [pick('fish', 'large'), pick('starch', 'ugali')], 1));
    expect(joined).toHaveLength(1);
    expect(joined[0]?.servings).toBe(3);
  });
  it('changes servings, removes, and counts servings for the badge', () => {
    expect(setPackageServings([a, b], a.id, 4)[0]?.servings).toBe(4);
    expect(removePackageLine([a, b], a.id)).toEqual([b]);
    expect(packageBadgeCount([a, b])).toBe(3);
  });
  it('round-trips through the browser and refuses junk', () => {
    expect(parsePackageCart(serializePackageCart([a, b]))).toEqual([a, b]);
    for (const bad of [null, '', 'x', '{}', '[1,"a"]', JSON.stringify([{ productId: 'p', servings: 'x', picks: [] }])]) expect(parsePackageCart(bad)).toEqual([]);
    expect(parsePackageCart(JSON.stringify([{ productId: 'p', servings: 1, picks: [{ slotId: 's', optionId: 'o', count: -1 }, { slotId: 's', optionId: 'o', count: 1.5 }] }]))[0]?.picks).toEqual([]);
  });

  it('keeps a note with the line, so the same choices with another note are another line', () => {
    const plain = packageLine('lunch', [pick('fish', 'small')], 1);
    const noted = packageLine('lunch', [pick('fish', 'small')], 1, '  no pepper ');
    expect(noted.note).toBe('no pepper');
    expect(noted.id).not.toBe(plain.id);
    expect(addPackageLine([plain], noted)).toHaveLength(2);
    expect(addPackageLine([noted], packageLine('lunch', [pick('fish', 'small')], 2, 'no pepper'))[0]?.servings).toBe(3);
    expect(parsePackageCart(serializePackageCart([plain, noted]))).toEqual([plain, noted]);
    expect(packageLine('lunch', [], 1, 'x'.repeat(500)).note).toHaveLength(200);
  });
});

describe('a line that came from a group order', () => {
  const group = '3f2a9c1e-5b7d-4e0a-9c11-0a1b2c3d4e5f';
  it('keeps the group it came from, through the browser\'s storage', () => {
    const line = packageLine('lunch', [pick('fish', 'small')], 2, '', group);
    expect(line.groupId).toBe(group);
    expect(parsePackageCart(serializePackageCart([line]))[0]?.groupId).toBe(group);
    expect(packageLine('lunch', [pick('fish', 'small')], 1).groupId).toBeUndefined();
  });
  it('drops a group id that is not an id, so nothing odd is kept or sent', () => {
    expect(packageLine('lunch', [pick('fish', 'small')], 1, '', 'not-an-id').groupId).toBeUndefined();
    expect(parsePackageCart(JSON.stringify([{ productId: 'lunch', picks: [pick('fish', 'small')], servings: 1, groupId: '<script>' }]))[0]?.groupId).toBeUndefined();
  });
  it('does not change which lines are the same, and an equal line joins it and keeps the group', () => {
    const own = packageLine('lunch', [pick('fish', 'small')], 1);
    const fromGroup = packageLine('lunch', [pick('fish', 'small')], 2, '', group);
    expect(fromGroup.id).toBe(own.id);
    const joined = addPackageLine([own], fromGroup);
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ servings: 3, groupId: group });
  });
});
