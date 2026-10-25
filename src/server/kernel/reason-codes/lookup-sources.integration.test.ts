import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { has } from '@/lib/values';
import type * as mod_client from '@/server/db/drizzle/client';
import type * as mod_schema from '@/server/db/drizzle/schema';

/** Reasons that belong to one kind of document stay out of the general pickers.   TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('general reason pickers (database)', () => {
  let db: typeof mod_client.drizzleDb;
  let schema: typeof mod_schema;
  let companyId: string;
  const tag = randomUUID().slice(0, 6).toUpperCase();

  beforeAll(async () => {
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    const { getContainer } = await import('@/server/di/container');
    companyId = (await getContainer().companySettings.ensureSeeded()).id;
    await db.insert(schema.reasonCodes).values([
      { companyId, code: `ANY_${tag}`, description: `Anywhere ${tag}`, appliesTo: [] },
      { companyId, code: `VEND_${tag}`, description: `Another reason (explain) ${tag}`, appliesTo: ['vendor_standing'], requiresComment: true },
    ]);
  });

  it('offers a reason that applies anywhere and hides one tied to a vendor', async () => {
    const { APPLIES_ANYWHERE } = await import('./lookup-sources');
    const rows = await db
      .select({ code: schema.reasonCodes.code })
      .from(schema.reasonCodes)
      .where(and(eq(schema.reasonCodes.companyId, companyId), eq(schema.reasonCodes.isActive, true), APPLIES_ANYWHERE));
    const codes = rows.map((r) => r.code);
    expect(codes).toContain(`ANY_${tag}`);
    expect(codes).not.toContain(`VEND_${tag}`);
  });
});
