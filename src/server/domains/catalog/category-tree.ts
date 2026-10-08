/** Deepest a category tree may go: a category, and up to four levels of sub-categories under it. */
export const MAX_CATEGORY_DEPTH = 5;

interface Node {
  id: string;
  name: string;
  parentId: string | null;
  displayOrder: number;
}

/** A category's own id, then each category above it, nearest first. Stops if the data loops. */
export function categoryChain(id: string | null, parents: Map<string, string | null>): string[] {
  const chain: string[] = [];
  let at = id;
  while (at != null && parents.has(at) && !chain.includes(at)) {
    chain.push(at);
    at = parents.get(at) ?? null;
  }
  return chain;
}

/** Every category at or below `id` (so a rule on "Shoes" covers "Running shoes" too). */
export function descendantsOf(id: string, parents: Map<string, string | null>): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const [child, parent] of parents) {
      if (parent === out[i] && !out.includes(child)) out.push(child);
    }
  }
  return out;
}

/** Why `parentId` cannot be the parent of `id`, or null when it can. */
export function parentProblem(
  id: string | null,
  parentId: string | null,
  parents: Map<string, string | null>,
): string | null {
  if (parentId == null) return null;
  if (!parents.has(parentId)) return 'The category it should sit under does not exist.';
  if (id != null && parentId === id) return 'A category cannot sit under itself.';
  const above = categoryChain(parentId, parents);
  if (id != null && above.includes(id))
    return 'A category cannot sit under one of its own sub-categories.';
  // The new branch would reach this deep: the parent's level, plus the category, plus anything below it.
  const below = id == null ? 0 : subtreeHeight(id, parents);
  if (above.length + 1 + below > MAX_CATEGORY_DEPTH)
    return `Categories can go at most ${MAX_CATEGORY_DEPTH} levels deep.`;
  return null;
}

function subtreeHeight(id: string, parents: Map<string, string | null>): number {
  let height = 0;
  let level = [id];
  const seen = new Set(level);
  while (level.length > 0) {
    const next: string[] = [];
    for (const [child, parent] of parents) {
      if (parent != null && level.includes(parent) && !seen.has(child)) {
        seen.add(child);
        next.push(child);
      }
    }
    if (next.length > 0) height++;
    level = next;
  }
  return height;
}

/** Lists categories as a tree, each under its parent, with its path and depth. */
export function inTreeOrder<T extends Node>(rows: T[]): Array<T & { path: string; depth: number }> {
  const byParent = new Map<string | null, T[]>();
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    // A category whose parent is missing is shown at the top rather than lost.
    const key = r.parentId != null && ids.has(r.parentId) ? r.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), r]);
  }
  const out: Array<T & { path: string; depth: number }> = [];
  const visit = (parent: string | null, path: string[], seen: Set<string>) => {
    const kids = (byParent.get(parent) ?? []).sort(
      (a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name),
    );
    for (const k of kids) {
      if (seen.has(k.id)) continue;
      const here = [...path, k.name];
      out.push({ ...k, path: here.join(' › '), depth: path.length });
      visit(k.id, here, new Set([...seen, k.id]));
    }
  };
  visit(null, [], new Set());
  return out;
}
