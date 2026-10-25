import { eq, sql, type SQL } from 'drizzle-orm';
import { reasonCodes } from '@/server/db/drizzle/schema';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { acceptFilters, tableSource, type LookupSource } from '@/server/domains/lookups/runner';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Reasons tied to one kind of document (a vendor's standing, an RFQ rejection) never appear in a general picker:
 * only reasons that apply anywhere do, unless the screen narrows to its own kind.
 */
export const APPLIES_ANYWHERE: SQL = sql`jsonb_array_length(${reasonCodes.appliesTo}) = 0`;

/** The active reasons a person may give for a change, behind the permission of the screen that asks. */
const reasons = (key: string, permission: PermissionKey, narrow?: SQL): LookupSource =>
  tableSource({
    key,
    permission,
    table: reasonCodes,
    id: reasonCodes.code,
    label: reasonCodes.description,
    searchColumns: [reasonCodes.description, reasonCodes.code],
    select: { requiresComment: reasonCodes.requiresComment },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(reasonCodes.companyId, companyId), eq(reasonCodes.isActive, true), narrow ?? APPLIES_ANYWHERE];
    },
    toOption: (row) => ({
      id: text(row.id),
      label: text(row.label),
      description: null,
      badge: null,
      meta: { requiresComment: row.requiresComment === true ? '1' : '' },
    }),
  });

export const REASON_LOOKUP_SOURCES: LookupSource[] = [
  reasons('numbering-reasons', 'numbering:manage'),
  reasons('approval-config-reasons', 'approvals:manage'),
  reasons('approval-reasons', 'approvals:act'),
  reasons('pricing-reasons', 'pricing:read', sql`(jsonb_array_length(${reasonCodes.appliesTo}) = 0 or ${reasonCodes.appliesTo} @> '["pricing_configuration"]'::jsonb)`),
];
