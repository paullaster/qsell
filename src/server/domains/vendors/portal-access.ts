import { and, eq } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { vendors, vendorUsers, type VendorPortalRole } from '@/server/db/drizzle/schema';

export interface PortalAccess {
  vendorId: string;
  portalRole: VendorPortalRole;
}

/**
 * The vendor business a signed-in user may act for, or null. It is read from the database at sign-in and again every
 * minute, so a removed portal user or an archived vendor loses access within a minute. A blocked-for-payment vendor keeps
 * its access (it must still be able to see why); an archived one does not.
 */
export async function findPortalAccess(userId: string): Promise<PortalAccess | null> {
  const [row] = await drizzleDb
    .select({ vendorId: vendorUsers.vendorId, portalRole: vendorUsers.portalRole, status: vendors.status })
    .from(vendorUsers)
    .innerJoin(vendors, eq(vendors.id, vendorUsers.vendorId))
    .where(and(eq(vendorUsers.userId, userId), eq(vendorUsers.status, 'active')));
  if (row === undefined || row.status === 'archived') return null;
  return { vendorId: row.vendorId, portalRole: row.portalRole };
}
