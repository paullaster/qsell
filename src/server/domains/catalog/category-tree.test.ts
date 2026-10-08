import { describe, expect, it } from 'vitest';
import {
  categoryChain,
  descendantsOf,
  inTreeOrder,
  MAX_CATEGORY_DEPTH,
  parentProblem,
} from './category-tree';

const parents = (pairs: Array<[string, string | null]>) => new Map(pairs);
const tree = parents([
  ['shoes', null],
  ['running', 'shoes'],
  ['trail', 'running'],
  ['bags', null],
]);

describe('category tree', () => {
  it('walks from a category up to the top', () => {
    expect(categoryChain('trail', tree)).toEqual(['trail', 'running', 'shoes']);
    expect(categoryChain('bags', tree)).toEqual(['bags']);
    expect(categoryChain(null, tree)).toEqual([]);
    expect(categoryChain('gone', tree)).toEqual([]);
  });

  it('does not loop forever on bad data', () => {
    const loop = parents([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    expect(categoryChain('a', loop)).toEqual(['a', 'b']);
  });

  it('finds everything at or below a category', () => {
    expect(descendantsOf('shoes', tree).sort()).toEqual(['running', 'shoes', 'trail']);
    expect(descendantsOf('bags', tree)).toEqual(['bags']);
  });

  it('refuses a parent that does not exist, itself, or one of its own sub-categories', () => {
    expect(parentProblem('bags', 'nope', tree)).toContain('does not exist');
    expect(parentProblem('shoes', 'shoes', tree)).toContain('under itself');
    expect(parentProblem('shoes', 'trail', tree)).toContain('own sub-categories');
    expect(parentProblem('bags', 'shoes', tree)).toBeNull();
    expect(parentProblem('bags', null, tree)).toBeNull();
    expect(parentProblem(null, 'running', tree)).toBeNull();
  });

  it('limits how deep the tree can grow, counting what already hangs below', () => {
    const chain: Array<[string, string | null]> = [['c0', null]];
    for (let i = 1; i < MAX_CATEGORY_DEPTH; i++) chain.push([`c${i}`, `c${i - 1}`]);
    const deep = parents(chain);
    expect(parentProblem(null, `c${MAX_CATEGORY_DEPTH - 1}`, deep)).toContain('levels deep');
    expect(parentProblem(null, `c${MAX_CATEGORY_DEPTH - 2}`, deep)).toBeNull();
    // Moving a branch with children under a deep parent counts the branch's own height too.
    const withBranch = parents([...chain, ['x', null], ['x1', 'x']]);
    expect(parentProblem('x', `c${MAX_CATEGORY_DEPTH - 2}`, withBranch)).toContain('levels deep');
  });

  it('lists categories as a tree with paths and depth', () => {
    const rows = [
      { id: 'trail', name: 'Trail', parentId: 'running', displayOrder: 1 },
      { id: 'bags', name: 'Bags', parentId: null, displayOrder: 2 },
      { id: 'shoes', name: 'Shoes', parentId: null, displayOrder: 1 },
      { id: 'running', name: 'Running', parentId: 'shoes', displayOrder: 1 },
    ];
    const out = inTreeOrder(rows);
    expect(out.map((r) => r.path)).toEqual([
      'Shoes',
      'Shoes › Running',
      'Shoes › Running › Trail',
      'Bags',
    ]);
    expect(out.map((r) => r.depth)).toEqual([0, 1, 2, 0]);
  });

  it('shows a category whose parent is missing at the top instead of losing it', () => {
    const out = inTreeOrder([{ id: 'x', name: 'Orphan', parentId: 'gone', displayOrder: 1 }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ path: 'Orphan', depth: 0 });
  });
});
