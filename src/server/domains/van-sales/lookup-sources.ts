import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { bankAccounts, branches, customers, deliveryVehicles, products, salesReps, salesRoutes, users, vans } from '@/server/db/drizzle/schema';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { LookupFilterError, acceptFilters, tableSource, type LookupSource } from '@/server/domains/lookups/runner';
import { isId } from '@/lib/van-sales/people';
import { STAFF_SQL } from './reps';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The branches a van or a rep can belong to. */
const branchesToChoose = tableSource({
  key: 'van-branches',
  permission: 'van_sales:manage',
  table: branches,
  id: branches.id,
  label: branches.name,
  searchColumns: [branches.name, branches.code],
  select: { code: branches.code },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [and(eq(branches.companyId, companyId), eq(branches.isActive, true)) ?? sql`false`];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.code), badge: null }),
});

/** The cash accounts a van's till keeps its money in. */
const cashAccounts = tableSource({
  key: 'van-cash-accounts',
  permission: 'van_sales:manage',
  table: bankAccounts,
  id: bankAccounts.id,
  label: bankAccounts.name,
  searchColumns: [bankAccounts.name, bankAccounts.code],
  select: { code: bankAccounts.code },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.kind, 'cash'), eq(bankAccounts.blocked, false)) ?? sql`false`];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.code), badge: null }),
});

/** Vehicles in use that are not already behind a van in use. */
const freeVehicles = tableSource({
  key: 'van-vehicles',
  permission: 'van_sales:manage',
  table: deliveryVehicles,
  id: deliveryVehicles.id,
  label: deliveryVehicles.name,
  searchColumns: [deliveryVehicles.name],
  select: { maxWeightKg: deliveryVehicles.maxWeightKg },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [
      and(
        eq(deliveryVehicles.companyId, companyId),
        eq(deliveryVehicles.isActive, true),
        sql`NOT EXISTS (SELECT 1 FROM vans v WHERE v.vehicle_id = ${deliveryVehicles.id} AND v.status = 'active')`,
      ) ?? sql`false`,
    ];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: typeof row.maxWeightKg === 'string' || typeof row.maxWeightKg === 'number' ? `up to ${String(row.maxWeightKg)} kg` : null, badge: null }),
});

/** Members of staff who are not sales reps yet, for making one a rep. */
const staffToSell = tableSource({
  key: 'van-staff',
  permission: 'van_sales:manage',
  table: users,
  id: users.id,
  label: users.name,
  searchColumns: [users.name, users.email],
  select: { email: users.email },
  scope: ({ filters, companyId }) => {
    acceptFilters(filters, {});
    return [
      and(
        eq(users.status, 'active'),
        eq(users.isActive, true),
        STAFF_SQL,
        sql`NOT EXISTS (SELECT 1 FROM ${salesReps} r WHERE r.user_id = ${users.id} AND r.company_id = ${companyId}::uuid)`,
      ) ?? sql`false`,
    ];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.email), badge: null }),
});

/** The one filter these lists take: the id of a record (a route or a branch), checked here before it reaches a query. */
const idFilter = (filters: Record<string, string>, name: string): string | null => {
  const { [name]: value, ...rest } = filters;
  if (Object.keys(rest).length > 0) throw new LookupFilterError('Unsupported filter.');
  if (value === undefined) return null;
  if (!isId(value)) throw new LookupFilterError('That is not a valid choice.');
  return value;
};

/** Vans in use, for a route's usual van or a day's van; with the filter `branch`, only the vans of that branch. */
const vansInUse = (key: string, permission: PermissionKey) =>
  tableSource({
    key,
    permission,
    table: vans,
    id: vans.id,
    label: vans.name,
    searchColumns: [vans.name],
    select: { branchId: vans.branchId },
    scope: ({ companyId, filters }) => {
      const branch = idFilter(filters, 'branch');
      const conditions: SQL[] = [eq(vans.companyId, companyId), eq(vans.status, 'active')];
      if (branch !== null) conditions.push(eq(vans.branchId, branch));
      return [and(...conditions) ?? sql`false`];
    },
    toOption: (row) => ({ id: text(row.id), label: text(row.label), description: null, badge: null }),
  });

/** Sales reps who are selling, for a route's usual rep or a day's rep. */
const repsSelling = (key: string, permission: PermissionKey) =>
  tableSource({
    key,
    permission,
    table: salesReps,
    id: salesReps.id,
    label: salesReps.name,
    searchColumns: [salesReps.name, salesReps.phone],
    select: { phone: salesReps.phone },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [and(eq(salesReps.companyId, companyId), eq(salesReps.status, 'active')) ?? sql`false`];
    },
    toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.phone) === '' ? null : text(row.phone), badge: null }),
  });

/** The place a customer shows in a list: town and phone. */
const placeOf = (row: Record<string, unknown>): string | null => {
  const place = [text(row.city), text(row.phone)].filter((x) => x !== '').join(' · ');
  return place === '' ? null : place;
};

/** Customers who can be put on a route (filter `route` hides those already on it) or added to a day (filter `day` hides those already on its visits). */
const customersFor = (key: string, permission: PermissionKey, on: 'route' | 'day') =>
  tableSource({
    key,
    permission,
    table: customers,
    id: customers.id,
    label: customers.name,
    searchColumns: [customers.name, customers.phone, customers.number, customers.email],
    select: { city: customers.city, phone: customers.phone },
    scope: ({ companyId, filters }) => {
      const where = idFilter(filters, on);
      const conditions: SQL[] = [eq(customers.companyId, companyId), eq(customers.isActive, true), eq(customers.isWalkIn, false)];
      if (where !== null && on === 'route') conditions.push(sql`NOT EXISTS (SELECT 1 FROM route_stops s WHERE s.route_id = ${where}::uuid AND s.customer_id = ${customers.id} AND s.active)`);
      if (where !== null && on === 'day') conditions.push(sql`NOT EXISTS (SELECT 1 FROM van_visits v WHERE v.day_id = ${where}::uuid AND v.customer_id = ${customers.id})`);
      return [and(...conditions) ?? sql`false`];
    },
    toOption: (row) => ({ id: text(row.id), label: text(row.label), description: placeOf(row), badge: null }),
  });

/** Routes in use, for planning a day: each shows what it is for and its usual van and rep. */
const routesInUse = tableSource({
  key: 'van-plan-routes',
  permission: 'van_sales:plan',
  table: salesRoutes,
  id: salesRoutes.id,
  label: salesRoutes.name,
  searchColumns: [salesRoutes.name, salesRoutes.code],
  select: { code: salesRoutes.code, mode: salesRoutes.mode },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [and(eq(salesRoutes.companyId, companyId), eq(salesRoutes.status, 'active')) ?? sql`false`];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.code), badge: null, meta: { mode: text(row.mode) } }),
});

/** Products a van can carry (kept in stock); with the filter `route`, not already on that route's usual stock. */
const productsForVan = tableSource({
  key: 'van-products',
  permission: 'van_sales:manage',
  table: products,
  id: products.id,
  label: products.name,
  searchColumns: [products.name, products.sku, products.stockCode],
  select: { sku: products.sku },
  scope: ({ filters }) => {
    const route = idFilter(filters, 'route');
    const conditions: SQL[] = [isNull(products.deletedAt), eq(products.inventoryKind, 'inventory')];
    if (route !== null) conditions.push(sql`NOT EXISTS (SELECT 1 FROM route_par_levels p WHERE p.route_id = ${route}::uuid AND p.product_id = ${products.id})`);
    return [and(...conditions) ?? isNull(products.deletedAt)];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.sku) === '' ? null : text(row.sku), badge: null }),
});

export const VAN_SALES_LOOKUP_SOURCES: LookupSource[] = [
  branchesToChoose,
  cashAccounts,
  freeVehicles,
  staffToSell,
  vansInUse('van-vans', 'van_sales:manage'),
  repsSelling('van-reps', 'van_sales:manage'),
  customersFor('van-customers', 'van_sales:manage', 'route'),
  productsForVan,
  // The same lists for the people who plan days (who may not set up vans, reps and routes).
  routesInUse,
  vansInUse('van-plan-vans', 'van_sales:plan'),
  repsSelling('van-plan-reps', 'van_sales:plan'),
  customersFor('van-plan-customers', 'van_sales:plan', 'day'),
];
