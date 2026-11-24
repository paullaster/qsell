/**
 * A believable year of trade for the style guide, screenshots and tests: weekly rhythm, a December peak, a promotion in
 * March, a slow branch and a star product. It is generated from a seed (never random at run time), so every run, server and
 * browser draws exactly the same picture, and tests can assert on it.
 */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Busier in December, a promotion in March, quiet in January (by month number, 0 is January). */
const SEASON: Readonly<Record<number, number>> = { 0: 0.8, 2: 1.2, 11: 1.6 };

export interface DemoDay {
  date: string;
  sales: number;
  orders: number;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `days` consecutive days from a start date, with their sales and orders. */
export function demoDays(start: string, days: number, seed = 7): DemoDay[] {
  const rand = rng(seed);
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  const out: DemoDay[] = [];
  for (let i = 0; i < days; i += 1) {
    const day = new Date(Date.UTC(y, m - 1, d + i));
    const month = day.getUTCMonth();
    const weekday = day.getUTCDay();
    const weekly = [0.7, 0.9, 0.95, 1, 1.1, 1.45, 1.25][weekday] ?? 1;
    const season = SEASON[month] ?? 1;
    const orders = Math.max(0, Math.round(60 * weekly * season * (0.85 + rand() * 0.3)));
    const average = 2400 + rand() * 600;
    out.push({
      date: `${String(day.getUTCFullYear())}-${pad(month + 1)}-${pad(day.getUTCDate())}`,
      sales: Math.round(orders * average),
      orders,
    });
  }
  return out;
}

export interface DemoRanked {
  key: string;
  label: string;
  value: number;
  note: string;
  changePct: number | null;
}

export const DEMO_PRODUCTS: readonly DemoRanked[] = [
  {
    key: 'p1',
    label: 'Sunlight laundry soap 1kg',
    value: 1_284_000,
    note: '4,280 units',
    changePct: 18.4,
  },
  {
    key: 'p2',
    label: 'Brookside milk 500ml',
    value: 986_500,
    note: '19,730 units',
    changePct: 6.2,
  },
  { key: 'p3', label: 'Unga Jogoo 2kg', value: 842_000, note: '5,260 units', changePct: -3.1 },
  {
    key: 'p4',
    label: 'Pembe maize flour 1kg',
    value: 611_300,
    note: '6,790 units',
    changePct: 2.4,
  },
  { key: 'p5', label: 'Cooking oil 3L', value: 598_800, note: '1,330 units', changePct: -9.8 },
  { key: 'p6', label: 'Royco mchuzi mix', value: 402_100, note: '8,040 units', changePct: null },
];

export const DEMO_BRANCHES = ['Nairobi CBD', 'Westlands', 'Mombasa', 'Kisumu'] as const;

export const DEMO_METHODS = [
  { key: 'mpesa', label: 'M-Pesa', value: 6_420_000 },
  { key: 'cash', label: 'Cash', value: 3_180_000 },
  { key: 'card', label: 'Card', value: 1_240_000 },
  { key: 'credit', label: 'On account', value: 920_000 },
  { key: 'gift', label: 'Gift cards', value: 140_000 },
] as const;

/** Monthly sales by branch for a year: the capital leads, Kisumu is the slow branch. */
export function demoBranchMonths(seed = 11): {
  months: string[];
  byBranch: { label: string; values: number[] }[];
} {
  const rand = rng(seed);
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const base = [1_900_000, 1_400_000, 1_150_000, 620_000];
  const season = [0.8, 0.85, 1.2, 1, 1, 0.95, 0.95, 1, 1.05, 1.1, 1.2, 1.6];
  return {
    months,
    byBranch: DEMO_BRANCHES.map((label, b) => ({
      label,
      values: season.map((s) => Math.round((base[b] ?? 500_000) * s * (0.92 + rand() * 0.16))),
    })),
  };
}
