import { eq, and } from 'drizzle-orm';
import { branches } from '@/server/db/drizzle/schema';
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

export const SHIFT_LOOKUP_SOURCES: LookupSource[] = [registerBranches, openableRegisters];
