import { and, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { paymentProviderConfigs, type PaymentProviderConfigRow } from '@/server/db/drizzle/schema';

export const MANUAL_PROVIDER_NAME = 'Manual (no outside service)';

type Db = Pick<DrizzleDb, 'select' | 'insert'>;

/**
 * Cash, cheques and manual bank deposits do not go through an outside company, but every payment
 * method goes through exactly one provider. This is the built-in one for them: no credentials,
 * always on, cannot be deleted. Created the first time it is needed.
 */
export async function ensureManualProvider(db: Db, companyId: string): Promise<PaymentProviderConfigRow> {
  const [found] = await db
    .select()
    .from(paymentProviderConfigs)
    .where(and(eq(paymentProviderConfigs.companyId, companyId), eq(paymentProviderConfigs.providerCode, 'manual')))
    .limit(1);
  if (found) return found;
  const [created] = await db
    .insert(paymentProviderConfigs)
    .values({
      companyId,
      branchId: null,
      providerCode: 'manual',
      isSystem: true,
      displayName: MANUAL_PROVIDER_NAME,
      isEnabled: true,
      environment: 'production',
      apiBaseUrl: 'manual://none',
      settings: {},
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [again] = await db
    .select()
    .from(paymentProviderConfigs)
    .where(and(eq(paymentProviderConfigs.companyId, companyId), eq(paymentProviderConfigs.providerCode, 'manual')))
    .limit(1);
  return again!;
}
