import { describe, expect, it } from 'vitest';
import {
  addCatalogueEntry,
  canNudgeLine,
  type CatalogueEntry,
  dropLine,
  dropSection,
  indexesIn,
  moveLine,
  moveSection,
  nudgeLine,
  nudgeSection,
  placeOf,
  removeSection,
} from './quote-layout';

type L = { name: string; sectionId?: string | null };
const l = (name: string, sectionId: string | null = null): L => ({ name, sectionId });
const names = (lines: L[], slot: string | null) =>
  indexesIn(lines, slot).map((i) => lines[i]!.name);
const S = [{ id: 'A' }, { id: 'B' }];

// Individual: i1 i2 i3.  A: a1 a2.  B: b1.   (interleaved in the list, as real quotes are)
const base = (): L[] => [l('i1'), l('a1', 'A'), l('i2'), l('b1', 'B'), l('a2', 'A'), l('i3')];

describe('moving a line to a place', () => {
  it('within its place, to the front, the middle and the end', () => {
    expect(names(moveLine(base(), 5, null, 0), null)).toEqual(['i3', 'i1', 'i2']);
    expect(names(moveLine(base(), 0, null, 1), null)).toEqual(['i2', 'i1', 'i3']);
    expect(names(moveLine(base(), 0, null, 99), null)).toEqual(['i2', 'i3', 'i1']);
  });
  it('into a section, at a position, and the other places are untouched', () => {
    const out = moveLine(base(), 0, 'A', 1);
    expect(names(out, 'A')).toEqual(['a1', 'i1', 'a2']);
    expect(names(out, null)).toEqual(['i2', 'i3']);
    expect(names(out, 'B')).toEqual(['b1']);
    expect(out.find((x) => x.name === 'i1')!.sectionId).toBe('A');
  });
  it('into an empty section', () => {
    const out = moveLine([l('x'), l('y')], 1, 'C', 0);
    expect(names(out, 'C')).toEqual(['y']);
    expect(names(out, null)).toEqual(['x']);
  });
  it('out of a section to the individual items', () => {
    const out = moveLine(base(), 1, null, 2);
    expect(names(out, null)).toEqual(['i1', 'i2', 'a1', 'i3']);
    expect(out.find((x) => x.name === 'a1')!.sectionId).toBeNull();
  });
  it('never loses or duplicates a line, whatever the move', () => {
    for (let from = 0; from < 6; from++)
      for (const slot of [null, 'A', 'B'])
        for (const pos of [0, 1, 2, 9]) {
          const out = moveLine(base(), from, slot, pos);
          expect(out.map((x) => x.name).sort()).toEqual(
            base()
              .map((x) => x.name)
              .sort(),
          );
          expect(out[out.findIndex((x) => x.name === base()[from]!.name)]!.sectionId ?? null).toBe(
            slot,
          );
        }
  });
  it('hands back the same list when nothing changes, and ignores a bad index', () => {
    const lines = base();
    expect(moveLine(lines, 0, null, 0)).toBe(lines);
    expect(moveLine(lines, 99, null, 0)).toBe(lines);
    expect(moveLine(lines, -1, null, 0)).toBe(lines);
  });
  it('does not change its input', () => {
    const lines = base();
    const copy = JSON.stringify(lines);
    moveLine(lines, 0, 'A', 0);
    expect(JSON.stringify(lines)).toBe(copy);
  });
});

describe('the arrows', () => {
  it('move a line one place within its group', () => {
    expect(names(nudgeLine(base(), S, 2, -1), null)).toEqual(['i2', 'i1', 'i3']);
    expect(names(nudgeLine(base(), S, 2, 1), null)).toEqual(['i1', 'i3', 'i2']);
  });
  it('carry a line over the edge into the next group along', () => {
    // a1 is first in A: up goes to the end of the individual items.
    const up = nudgeLine(base(), S, 1, -1);
    expect(names(up, null)).toEqual(['i1', 'i2', 'i3', 'a1']);
    expect(names(up, 'A')).toEqual(['a2']);
    // i3 is last individual: down goes to the top of A.
    const down = nudgeLine(base(), S, 5, 1);
    expect(names(down, 'A')).toEqual(['i3', 'a1', 'a2']);
    // a2 is last in A: down goes to the top of B.
    expect(names(nudgeLine(base(), S, 4, 1), 'B')).toEqual(['a2', 'b1']);
  });
  it('stop at the very top and the very bottom', () => {
    const lines = base();
    expect(nudgeLine(lines, S, 0, -1)).toBe(lines);
    expect(nudgeLine(lines, S, 3, 1)).toBe(lines);
    expect(canNudgeLine(lines, S, 0, -1)).toBe(false);
    expect(canNudgeLine(lines, S, 3, 1)).toBe(false);
    expect(canNudgeLine(lines, S, 0, 1)).toBe(true);
    expect(canNudgeLine(lines, S, 3, -1)).toBe(true);
  });
  it('can take a line from the first place to the last using only the arrow', () => {
    let lines = base();
    for (let n = 0; n < 12; n++) {
      const at = lines.findIndex((x) => x.name === 'i1');
      lines = nudgeLine(lines, S, at, 1);
    }
    expect(names(lines, 'B').slice(-1)).toEqual(['i1']);
  });
});

describe('dropping a line', () => {
  it('before or after another line, in its section', () => {
    const before = dropLine(base(), 5, { kind: 'line', index: 1, after: false }); // i3 before a1
    expect(names(before, 'A')).toEqual(['i3', 'a1', 'a2']);
    const after = dropLine(base(), 5, { kind: 'line', index: 1, after: true });
    expect(names(after, 'A')).toEqual(['a1', 'i3', 'a2']);
  });
  it('within the same place, in the position the line was let go at', () => {
    // a1 dropped after a2 (it is before a2 now): ends last.
    expect(names(dropLine(base(), 1, { kind: 'line', index: 4, after: true }), 'A')).toEqual([
      'a2',
      'a1',
    ]);
    // a2 dropped before a1: ends first.
    expect(names(dropLine(base(), 4, { kind: 'line', index: 1, after: false }), 'A')).toEqual([
      'a2',
      'a1',
    ]);
    // i1 dropped before i3 stays ahead of it, after i2.
    expect(names(dropLine(base(), 0, { kind: 'line', index: 5, after: false }), null)).toEqual([
      'i2',
      'i1',
      'i3',
    ]);
  });
  it('onto a place: last in it, from anywhere', () => {
    expect(names(dropLine(base(), 0, { kind: 'slot', slot: 'B' }), 'B')).toEqual(['b1', 'i1']);
    expect(names(dropLine(base(), 1, { kind: 'slot', slot: null }), null)).toEqual([
      'i1',
      'i2',
      'i3',
      'a1',
    ]);
    expect(names(dropLine(base(), 3, { kind: 'slot', slot: 'A' }), 'A')).toEqual([
      'a1',
      'a2',
      'b1',
    ]);
  });
  it('onto itself, or nothing: unchanged', () => {
    const lines = base();
    expect(dropLine(lines, 2, { kind: 'line', index: 2, after: true })).toBe(lines);
    expect(dropLine(lines, 2, { kind: 'line', index: 99, after: true })).toBe(lines);
    expect(dropLine(lines, 99, { kind: 'slot', slot: null })).toBe(lines);
  });
  it('knows a line’s place', () => {
    expect(placeOf(base(), 4)).toEqual({ slot: 'A', position: 1, size: 2 });
  });
});

describe('sections', () => {
  const secs = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  it('move to a position, and by arrow', () => {
    expect(moveSection(secs, 0, 2).map((s) => s.id)).toEqual(['B', 'C', 'A']);
    expect(moveSection(secs, 2, 0).map((s) => s.id)).toEqual(['C', 'A', 'B']);
    expect(nudgeSection(secs, 1, -1).map((s) => s.id)).toEqual(['B', 'A', 'C']);
    expect(nudgeSection(secs, 1, 1).map((s) => s.id)).toEqual(['A', 'C', 'B']);
    expect(nudgeSection(secs, 0, -1)).toBe(secs);
    expect(nudgeSection(secs, 2, 1)).toBe(secs);
  });
  it('drop before or after another, whichever way it travels', () => {
    expect(dropSection(secs, 'A', 'C', false).map((s) => s.id)).toEqual(['B', 'A', 'C']);
    expect(dropSection(secs, 'A', 'C', true).map((s) => s.id)).toEqual(['B', 'C', 'A']);
    expect(dropSection(secs, 'C', 'A', false).map((s) => s.id)).toEqual(['C', 'A', 'B']);
    expect(dropSection(secs, 'C', 'A', true).map((s) => s.id)).toEqual(['A', 'C', 'B']);
    expect(dropSection(secs, 'A', 'A', true)).toBe(secs);
    expect(dropSection(secs, 'Z', 'A', true)).toBe(secs);
  });
  it('a section moved takes its lines’ grouping with it (lines name their section)', () => {
    const moved = moveSection(S, 0, 1);
    expect(names(base(), 'A')).toEqual(['a1', 'a2']);
    expect(moved.map((s) => s.id)).toEqual(['B', 'A']);
  });
  it('removing one turns its lines into individual items', () => {
    const out = removeSection(S, base(), 'A');
    expect(out.sections.map((s) => s.id)).toEqual(['B']);
    expect(names(out.lines, null)).toEqual(['i1', 'a1', 'i2', 'a2', 'i3']);
    expect(names(out.lines, 'B')).toEqual(['b1']);
  });
});

describe('addCatalogueEntry', () => {
  type Line = {
    productId: string;
    sectionId: string | null;
    quantity: number;
    discountPercent: number;
    unitPrice: number | null;
    priceMode: 'catalog' | 'manual';
  };
  const make = (e: CatalogueEntry): Line => ({
    productId: e.productId,
    sectionId: e.sectionId,
    quantity: e.quantity,
    discountPercent: e.discountPercent,
    unitPrice: e.unitPrice,
    priceMode: e.unitPrice === null ? 'catalog' : 'manual',
  });
  const typed = (l: Line) => l.priceMode === 'manual';
  const entry = (patch: Partial<CatalogueEntry> = {}): CatalogueEntry => ({
    productId: 'p1',
    sectionId: 's1',
    quantity: 2,
    unitPrice: null,
    discountPercent: 0,
    ...patch,
  });

  it('appends a new line and says where it went', () => {
    const r = addCatalogueEntry([], entry(), make, typed);
    expect(r.lines).toHaveLength(1);
    expect(r.index).toBe(0);
  });

  it('adds to the quantity of the same product in the same place', () => {
    const first = addCatalogueEntry([], entry(), make, typed).lines;
    const r = addCatalogueEntry(first, entry({ quantity: 1.5 }), make, typed);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.quantity).toBe(3.5);
    expect(r.index).toBe(0);
  });

  it('does not drift on repeated decimal adds', () => {
    let lines: Line[] = [];
    for (let i = 0; i < 3; i++) {
      lines = addCatalogueEntry(lines, entry({ quantity: 0.1 }), make, typed).lines;
    }
    expect(lines[0]!.quantity).toBe(0.3);
  });

  it('keeps separate lines for another section, discount or price', () => {
    const base = addCatalogueEntry([], entry(), make, typed).lines;
    expect(addCatalogueEntry(base, entry({ sectionId: null }), make, typed).lines).toHaveLength(2);
    expect(addCatalogueEntry(base, entry({ discountPercent: 5 }), make, typed).lines).toHaveLength(
      2,
    );
    expect(addCatalogueEntry(base, entry({ unitPrice: 90 }), make, typed).lines).toHaveLength(2);
  });

  it('merges typed prices only when they are equal', () => {
    const base = addCatalogueEntry([], entry({ unitPrice: 90 }), make, typed).lines;
    expect(addCatalogueEntry(base, entry({ unitPrice: 90 }), make, typed).lines).toHaveLength(1);
    expect(addCatalogueEntry(base, entry({ unitPrice: 80 }), make, typed).lines).toHaveLength(2);
    expect(addCatalogueEntry(base, entry(), make, typed).lines).toHaveLength(2);
  });

  it('does not change the lines it was given', () => {
    const base = addCatalogueEntry([], entry(), make, typed).lines;
    addCatalogueEntry(base, entry(), make, typed);
    expect(base[0]!.quantity).toBe(2);
  });
});
