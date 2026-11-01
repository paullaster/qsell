import { and, eq, sql } from 'drizzle-orm';
import { deliveryZones } from '@/server/db/drizzle/schema';
import { acceptFilters, tableSource, type LookupSource } from '@/server/domains/lookups/runner';

/** The delivery zones, for choosing one in a rate or an area. Stopped zones are not offered. */
const zones = tableSource({
  key: 'delivery-zones',
  permission: 'deliveries:read',
  table: deliveryZones,
  id: deliveryZones.id,
  label: deliveryZones.code,
  searchColumns: [deliveryZones.code, deliveryZones.name],
  select: { name: deliveryZones.name },
  scope: ({ filters, companyId }) => {
    acceptFilters(filters, {});
    return [and(eq(deliveryZones.companyId, companyId), eq(deliveryZones.isActive, true)) ?? sql`false`];
  },
  toOption: (row) => ({
    id: typeof row.id === 'string' ? row.id : '',
    label: `${typeof row.label === 'string' ? row.label : ''} · ${typeof row.name === 'string' ? row.name : ''}`,
    description: null,
    badge: null,
  }),
});

export const DELIVERY_LOOKUP_SOURCES: LookupSource[] = [zones];
