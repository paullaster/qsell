import { nth } from '@/lib/values';
/**
 * How the lines of a quote (or quote template) are laid out: some are individual items, the rest
 * sit in named sections. Lines live in one list; a line belongs to a section when it names one,
 * and its place inside the section is its order in that list. Sections have an order of their own.
 * On screen the individual items come first, then the sections in order.
 *
 * Everything here is pure: each function returns a new list and never changes its input.
 */
export interface Placed {
  sectionId?: string | null;
}

/** A place a line can sit: a section's id, or null for the individual items. */
export type Slot = string | null;

const slotOf = (l: Placed): Slot => l.sectionId ?? null;

/** The places, in the order they are shown: individual items first, then the sections. */
export const slotOrder = (sections: { id: string }[]): Slot[] => [
  null,
  ...sections.map((s) => s.id),
];

/** Where the lines of a place are in the list, in their order. */
export const indexesIn = (lines: Placed[], slot: Slot): number[] =>
  lines.flatMap((l, i) => (slotOf(l) === slot ? [i] : []));

/** Where a moved line goes in the list: before the member now at that position, or just after the last member, or the end when the place is empty. */
function insertionPoint(members: number[], at: number, listLength: number): number {
  const here = members[at];
  if (here !== undefined) return here;
  const last = members.at(-1);
  return last === undefined ? listLength : last + 1;
}

/**
 * Puts the line at `from` into `slot`, at `position` among that place's other lines (0 is first;
 * past the end is last). Positions count the place as it will be once the line has been taken
 * out, so moving a line within its own place to position 2 puts it third.
 */
export function moveLine<L extends Placed>(
  lines: L[],
  from: number,
  slot: Slot,
  position: number,
): L[] {
  if (from < 0 || from >= lines.length) return lines;
  // Already there: hand the same list back so callers can tell nothing moved.
  const cur = placeOf(lines, from);
  if (cur.slot === slot && Math.min(Math.max(0, position), cur.size - 1) === cur.position)
    return lines;
  const item = { ...nth(lines, from), sectionId: slot } as L;
  const rest = lines.filter((_, i) => i !== from);
  const members = indexesIn(rest, slot);
  const at = Math.min(Math.max(0, position), members.length);
  const insertAt = insertionPoint(members, at, rest.length);
  return [...rest.slice(0, insertAt), item, ...rest.slice(insertAt)];
}

export interface LinePlace {
  slot: Slot;
  /** Place among that slot's lines, from 0. */
  position: number;
  /** How many lines the slot has. */
  size: number;
}

export function placeOf(lines: Placed[], index: number): LinePlace {
  const slot = slotOf(nth(lines, index));
  const members = indexesIn(lines, slot);
  return { slot, position: members.indexOf(index), size: members.length };
}

/**
 * One place up (`-1`) or down (`+1`). A line at the edge of its place crosses into the next one
 * along (the last of the place above, or the first of the place below), so the arrows alone can
 * take a line anywhere.
 */
export function nudgeLine<L extends Placed>(
  lines: L[],
  sections: { id: string }[],
  index: number,
  dir: -1 | 1,
): L[] {
  if (index < 0 || index >= lines.length) return lines;
  const { slot, position, size } = placeOf(lines, index);
  if (dir === -1 ? position > 0 : position < size - 1)
    return moveLine(lines, index, slot, position + dir);
  const order = slotOrder(sections);
  const at = order.indexOf(slot);
  const next = order[at + dir];
  if (at < 0 || next === undefined) return lines;
  // Into the end of the place above, or the start of the place below.
  return moveLine(lines, index, next, dir === -1 ? Number.MAX_SAFE_INTEGER : 0);
}

export function canNudgeLine(
  lines: Placed[],
  sections: { id: string }[],
  index: number,
  dir: -1 | 1,
): boolean {
  if (index < 0 || index >= lines.length) return false;
  const { slot, position, size } = placeOf(lines, index);
  if (dir === -1 ? position > 0 : position < size - 1) return true;
  const order = slotOrder(sections);
  const at = order.indexOf(slot);
  return at >= 0 && order[at + dir] !== undefined;
}

/** Where a dragged line was let go. */
export type LineDrop =
  { kind: 'line'; index: number; after: boolean } | { kind: 'slot'; slot: Slot };

/** A line dropped on another line goes before or after it; dropped on a place, it goes last in it. */
export function dropLine<L extends Placed>(lines: L[], from: number, to: LineDrop): L[] {
  if (from < 0 || from >= lines.length) return lines;
  if (to.kind === 'slot') return moveLine(lines, from, to.slot, Number.MAX_SAFE_INTEGER);
  if (to.index === from || to.index < 0 || to.index >= lines.length) return lines;
  const target = placeOf(lines, to.index);
  let position = target.position + (to.after ? 1 : 0);
  const source = placeOf(lines, from);
  // The line leaves its place first, which pulls everything after it up by one.
  if (source.slot === target.slot && source.position < position) position -= 1;
  return moveLine(lines, from, target.slot, position);
}

/** Moves the section at `from` so it sits at `to` (counted once it has been taken out). */
export function moveSection<S extends { id: string }>(
  sections: S[],
  from: number,
  to: number,
): S[] {
  if (from < 0 || from >= sections.length) return sections;
  const rest = sections.filter((_, i) => i !== from);
  const at = Math.min(Math.max(0, to), rest.length);
  if (at === from) return sections;
  return [...rest.slice(0, at), nth(sections, from), ...rest.slice(at)];
}

export const nudgeSection = <S extends { id: string }>(
  sections: S[],
  index: number,
  dir: -1 | 1,
): S[] =>
  index + dir < 0 || index + dir >= sections.length
    ? sections
    : moveSection(sections, index, index + dir);

/** A section dropped on another goes before or after it. */
export function dropSection<S extends { id: string }>(
  sections: S[],
  fromId: string,
  targetId: string,
  after: boolean,
): S[] {
  const from = sections.findIndex((s) => s.id === fromId);
  const target = sections.findIndex((s) => s.id === targetId);
  if (from < 0 || target < 0 || from === target) return sections;
  let to = target + (after ? 1 : 0);
  if (from < to) to -= 1;
  return moveSection(sections, from, to);
}

/** Takes a section out; its lines become individual items, in the place they were. */
export function removeSection<S extends { id: string }, L extends Placed>(
  sections: S[],
  lines: L[],
  id: string,
): { sections: S[]; lines: L[] } {
  return {
    sections: sections.filter((s) => s.id !== id),
    lines: lines.map((l) => (slotOf(l) === id ? { ...l, sectionId: null } : l)),
  };
}

/** What the catalogue picker hands over for one item: where it goes and how it is set up. */
export interface CatalogueEntry {
  productId: string;
  sectionId: Slot;
  quantity: number;
  /** A price the person typed. Null leaves the price to the price lists. */
  unitPrice: number | null;
  discountPercent: number;
}

/** A line that can take more of the same item. */
type Stackable = Placed & {
  productId: string;
  quantity: number;
  discountPercent: number;
  /** A line typed in another unit of the product is never added to: items are added in the base unit. */
  unitId?: string | null;
};

/** Quantities are kept to three decimals, as the editors do, so repeated adds do not drift. */
const addQuantities = (a: number, b: number) => Math.round((a + b) * 1000) / 1000;

/**
 * Adds an item to the lines. When the same product already sits in that place with the same
 * discount and the same price (both left to the price lists, or both typed and equal), its quantity
 * goes up instead of a second row appearing; otherwise the new line goes last. Returns the new
 * list and the index of the line that took the item.
 *
 * `make` builds a new line; `typedPrice` says whether an existing line holds a typed price.
 */
export function addCatalogueEntry<L extends Stackable & { unitPrice?: number | null }>(
  lines: L[],
  entry: CatalogueEntry,
  make: (entry: CatalogueEntry) => L,
  typedPrice: (line: L) => boolean,
): { lines: L[]; index: number } {
  const hit = lines.findIndex(
    (l) =>
      l.productId === entry.productId &&
      (l.unitId === undefined || l.unitId === null) &&
      slotOf(l) === entry.sectionId &&
      l.discountPercent === entry.discountPercent &&
      (entry.unitPrice === null
        ? !typedPrice(l)
        : typedPrice(l) && Number(l.unitPrice) === entry.unitPrice),
  );
  if (hit < 0) return { lines: [...lines, make(entry)], index: lines.length };
  return {
    lines: lines.map((l, i) =>
      i === hit ? { ...l, quantity: addQuantities(l.quantity, entry.quantity) } : l,
    ),
    index: hit,
  };
}

/** Where the last line for a product sits in a place, or -1. */
export function lastIndexOfProduct(
  lines: (Placed & { productId: string })[],
  productId: string,
  slot: Slot,
): number {
  for (const [i, line] of [...lines.entries()].reverse()) {
    if (line.productId === productId && slotOf(line) === slot) return i;
  }
  return -1;
}
