/**
 * The preparation sheet: what the kitchen (or the packing bench) has to make for a day, read from the saved selections of orders,
 * never from the folded order lines (which no longer say which fish went with which ugali). Pure: the caller passes the rows.
 */

/** One saved selection with the order it belongs to, as read from the database. */
export interface PreparationRow {
  instanceId: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  /** The order's payment state, so the sheet can show what is not paid yet. */
  paymentStatus: string;
  packageProductId: string;
  packageName: string;
  servings: number;
  /** The delivery slot the shopper chose for that day, when there is one. */
  slotName: string | null;
  slotStartsAt: string | null;
  picks: { slotName: string; productId: string; productName: string; count: number; quantity: number; sortOrder: number }[];
}

export interface PreparedSelection {
  instanceId: string;
  orderNumber: string;
  customerName: string;
  paymentStatus: string;
  servings: number;
  /** "Large fish, Brown ugali and 2 × Sukuma" */
  words: string;
  picks: PreparationRow['picks'];
}

export interface PreparationGroup {
  /** The delivery slot (with its start time), or null for orders that chose none. */
  slotName: string | null;
  startsAt: string | null;
  packages: { packageProductId: string; packageName: string; servings: number; selections: PreparedSelection[] }[];
  servings: number;
}

export interface PreparationTotals {
  /** Servings of each package. */
  packages: { packageProductId: string; packageName: string; servings: number }[];
  /** Each chosen part: how many portions are wanted (servings x picks) and how many units of the product that is. */
  parts: { productId: string; productName: string; portions: number; units: number }[];
  servings: number;
}

export interface PreparationSheet {
  groups: PreparationGroup[];
  totals: PreparationTotals;
  orders: number;
}

const round3 = (n: number): number => Math.round((n + Number.EPSILON) * 1000) / 1000;

/** "a", "a and b", "a, b and c". */
function wordsList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/** The choices of one selection as a sentence, in the order the package asks them. */
export const picksWords = (picks: PreparationRow['picks']): string =>
  wordsList([...picks].sort((a, b) => a.sortOrder - b.sortOrder).map((p) => (p.count > 1 ? `${String(p.count)} × ${p.productName}` : p.productName)));

/**
 * Groups the selections of a day: by delivery slot (earliest first, orders with no slot last), then by package, then the
 * selections in the order they were made; and totals them. Identical selections of different orders stay separate lines (each has
 * its own order to prepare for), while the totals add everything up.
 */
export function buildSheet(rows: readonly PreparationRow[]): PreparationSheet {
  const groups = new Map<string, PreparationGroup>();
  const packageTotals = new Map<string, { packageProductId: string; packageName: string; servings: number }>();
  const partTotals = new Map<string, { productId: string; productName: string; portions: number; units: number }>();
  for (const row of rows) {
    const key = `${row.slotStartsAt ?? '~'}\u0000${row.slotName ?? ''}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { slotName: row.slotName, startsAt: row.slotStartsAt, packages: [], servings: 0 };
      groups.set(key, group);
    }
    let pkg = group.packages.find((p) => p.packageProductId === row.packageProductId);
    if (pkg === undefined) {
      pkg = { packageProductId: row.packageProductId, packageName: row.packageName, servings: 0, selections: [] };
      group.packages.push(pkg);
    }
    pkg.servings += row.servings;
    group.servings += row.servings;
    pkg.selections.push({ instanceId: row.instanceId, orderNumber: row.orderNumber, customerName: row.customerName, paymentStatus: row.paymentStatus, servings: row.servings, words: picksWords(row.picks), picks: [...row.picks].sort((a, b) => a.sortOrder - b.sortOrder) });

    const total = packageTotals.get(row.packageProductId) ?? { packageProductId: row.packageProductId, packageName: row.packageName, servings: 0 };
    total.servings += row.servings;
    packageTotals.set(row.packageProductId, total);
    for (const pick of row.picks) {
      const part = partTotals.get(pick.productId) ?? { productId: pick.productId, productName: pick.productName, portions: 0, units: 0 };
      part.portions += pick.count * row.servings;
      part.units = round3(part.units + pick.count * pick.quantity * row.servings);
      partTotals.set(pick.productId, part);
    }
  }
  const earlier = (a: PreparationGroup, b: PreparationGroup): number => {
    const byTime = (a.startsAt ?? '99:99').localeCompare(b.startsAt ?? '99:99');
    return byTime !== 0 ? byTime : (a.slotName ?? '').localeCompare(b.slotName ?? '');
  };
  const ordered = [...groups.values()].sort(earlier);
  for (const group of ordered) {
    group.packages.sort((a, b) => a.packageName.localeCompare(b.packageName));
    for (const pkg of group.packages) pkg.selections.sort((a, b) => a.orderNumber.localeCompare(b.orderNumber));
  }
  return {
    groups: ordered,
    totals: {
      packages: [...packageTotals.values()].sort((a, b) => a.packageName.localeCompare(b.packageName)),
      parts: [...partTotals.values()].sort((a, b) => (b.portions !== a.portions ? b.portions - a.portions : a.productName.localeCompare(b.productName))),
      servings: rows.reduce((n, r) => n + r.servings, 0),
    },
    orders: new Set(rows.map((r) => r.orderId)).size,
  };
}
