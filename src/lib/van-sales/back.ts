/**
 * Coming back at the end of the day (docs/architecture/van-sales.md §5.3, §7): when the rep can say they are back, what an unload may be, and when
 * the office can start settling the day. Pure; each says in words what is in the way.
 */
const names = (list: readonly string[]): string => (list.length <= 3 ? list.join(', ') : `${list.slice(0, 3).join(', ')} and ${String(list.length - 3)} more`);

/** Why the rep cannot say they are back yet, or null: every visit is finished or skipped, and every delivery has its result. */
export function backProblem(f: { dayStatus: string; visits: readonly { name: string; status: string }[]; openDeliveries: readonly string[] }): string | null {
  if (f.dayStatus !== 'out') return 'Only a day that is out on the route can come back.';
  const open = f.visits.filter((v) => v.status === 'planned' || v.status === 'arrived').map((v) => v.name);
  if (open.length > 0) return `${names(open)} ${open.length === 1 ? 'has' : 'have'} not been finished. Finish or skip ${open.length === 1 ? 'that visit' : 'those visits'} first.`;
  if (f.openDeliveries.length > 0) return `${names(f.openDeliveries)} ${f.openDeliveries.length === 1 ? 'has' : 'have'} not been delivered. Deliver ${f.openDeliveries.length === 1 ? 'it' : 'them'}, or say why not.`;
  return null;
}

export type UnloadState = 'none' | 'asked' | 'on_its_way' | 'received';

/** Why the van cannot be unloaded now, or null: the day is back, it has a van with stock on it, and it is not already being unloaded. */
export function unloadProblem(f: { dayStatus: string; hasVan: boolean; productsOnVan: number; unload: UnloadState }): string | null {
  if (!f.hasVan) return 'A day that only takes orders has no van to unload.';
  if (f.dayStatus !== 'returning') return 'The van is unloaded once the day is back.';
  if (f.unload !== 'none') return 'The van is already being unloaded.';
  if (f.productsOnVan === 0) return 'The van is empty, so there is nothing to unload.';
  return null;
}

/** Why the office cannot start settling the day yet, or null: a van with stock on it has been unloaded and the warehouse has received it. */
export function reconcileProblem(f: { dayStatus: string; hasVan: boolean; productsOnVan: number; unload: UnloadState }): string | null {
  if (f.dayStatus !== 'returning') return 'Settling starts once the day is back.';
  if (!f.hasVan) return null;
  if (f.unload === 'received') return null;
  if (f.unload === 'asked' || f.unload === 'on_its_way') return 'The unload has not been received at the warehouse yet.';
  return f.productsOnVan > 0 ? 'The van still has stock on it. Unload it first.' : null;
}
