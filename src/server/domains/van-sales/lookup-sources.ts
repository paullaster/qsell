import { and, eq, sql } from 'drizzle-orm';
import { bankAccounts, branches, deliveryVehicles, salesReps, users } from '@/server/db/drizzle/schema';
import { acceptFilters, tableSource, type LookupSource } from '@/server/domains/lookups/runner';
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

export const VAN_SALES_LOOKUP_SOURCES: LookupSource[] = [branchesToChoose, cashAccounts, freeVehicles, staffToSell];
