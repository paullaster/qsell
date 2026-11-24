import { and, eq, sql } from 'drizzle-orm';
import { branches } from '@/server/db/drizzle/schema';
import { acceptFilters, tableSource, type LookupSource } from '@/server/domains/lookups/runner';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The branches a report can be narrowed to. Only people who may run reports across every branch (`reports:all_branches`)
 * can search it: everyone else is held to their own branch and has no choice to make. Open branches only, one page at a
 * time, searched on the server.
 */
const reportBranches = tableSource({
  key: 'report-branches',
  permission: 'reports:all_branches',
  table: branches,
  id: branches.id,
  label: branches.name,
  searchColumns: [branches.name, branches.code],
  select: { code: branches.code },
  scope: ({ filters, companyId }) => {
    acceptFilters(filters, {});
    return [and(eq(branches.companyId, companyId), eq(branches.isActive, true)) ?? sql`false`];
  },
  toOption: (row) => ({
    id: text(row.id),
    label: text(row.label),
    description: text(row.code) === '' ? null : text(row.code),
    badge: null,
  }),
});

export const REPORT_LOOKUP_SOURCES: LookupSource[] = [reportBranches];
