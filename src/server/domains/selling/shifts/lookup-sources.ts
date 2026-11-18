import { eq, and } from 'drizzle-orm';
import { bankAccounts, branches, glAccounts } from '@/server/db/drizzle/schema';
import { getContainer } from '@/server/di/container';
import { acceptFilters, staticSource, tableSource, type LookupSource } from '@/server/domains/lookups/runner';

/** The company's branches, for choosing where a till is (staff who set up tills, not only those who may read the branches). */
const registerBranches = tableSource({
  key: 'register-branches',
  permission: 'registers:manage',
  table: branches,
  id: branches.id,
  label: branches.name,
  searchColumns: [branches.name, branches.code],
  select: { code: branches.code },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [and(eq(branches.companyId, companyId), eq(branches.isActive, true)) ?? eq(branches.isActive, true)];
  },
  toOption: (row) => ({ id: String(row.id), label: String(row.label), description: String(row.code), badge: null }),
});

/** The tills a shift can be opened on now: switched on, with no shift open. */
const openableRegisters = staticSource({
  key: 'shift-registers',
  permission: 'shifts:open',
  items: async ({ companyId }) => (await getContainer().shifts.registerList(companyId)).filter((r) => r.isActive && r.openBy === null).map((r) => ({ id: r.id, label: `${r.name} (${r.branchName})`, description: null, badge: null })),
});

/** The cash accounts a till's money can be kept in. */
const registerCashAccounts = tableSource({
  key: 'register-cash-accounts',
  permission: 'registers:manage',
  table: bankAccounts,
  id: bankAccounts.id,
  label: bankAccounts.name,
  searchColumns: [bankAccounts.name, bankAccounts.code],
  select: { code: bankAccounts.code },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.kind, 'cash'), eq(bankAccounts.blocked, false)) ?? eq(bankAccounts.kind, 'cash')];
  },
  toOption: (row) => ({ id: String(row.id), label: String(row.label), description: String(row.code), badge: null }),
});

/** The accounts a till's difference can be written to: open posting accounts of the chart. */
const varianceAccounts = tableSource({
  key: 'variance-gl-accounts',
  permission: 'registers:manage',
  table: glAccounts,
  id: glAccounts.id,
  label: glAccounts.name,
  searchColumns: [glAccounts.name, glAccounts.no],
  select: { no: glAccounts.no },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [and(eq(glAccounts.companyId, companyId), eq(glAccounts.type, 'posting'), eq(glAccounts.blocked, false)) ?? eq(glAccounts.type, 'posting')];
  },
  toOption: (row) => ({ id: String(row.id), label: `${String(row.no)} ${String(row.label)}`, description: null, badge: null }),
});

export const SHIFT_LOOKUP_SOURCES: LookupSource[] = [registerBranches, openableRegisters, registerCashAccounts, varianceAccounts];
