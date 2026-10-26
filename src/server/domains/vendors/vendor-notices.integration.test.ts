import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { has, required } from '@/lib/values';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_schema from '@/server/db/drizzle/schema';
import type { AppContainer } from '@/server/di/container';
import type { EmailMessage, EmailPort } from '@/server/ports/communications';
import { VendorNotifier } from './notifier';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

class Outbox implements EmailPort {
  readonly name = 'recorder';
  sent: EmailMessage[] = [];
  send(message: EmailMessage) {
    this.sent.push(message);
    return Promise.resolve({ messageId: 'x', provider: 'recorder' });
  }
}

describe.skipIf(!has(url))('mail about returns, refunds, contracts and requisitions (database)', () => {
  let db: DrizzleDb;
  let schema: typeof mod_schema;
  let c: AppContainer;
  const outbox = new Outbox();
  let notifier: VendorNotifier;
  let vendorId: string;
  const run = randomUUID().slice(0, 6);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    const { getContainer } = await import('@/server/di/container');
    c = getContainer();
    const [company] = await db.insert(schema.companySettings).values({ legalName: 'VN', tradingName: 'VN', email: 'buyer@vn.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' }).returning();
    notifier = new VendorNotifier(db, outbox, c.companySettings);
    const [u] = await db.insert(schema.users).values({ email: `vn.${run}@example.test`, passwordHash: 'x', name: 'Owner', role: 'vendor' }).returning();
    vendorId = await c.vendors.registerBusiness({ companyId: required(company).id, userId: required(u).id, legalName: `VN Vendor ${run}`, email: `vn.${run}@example.test`, phone: null });
  });

  it('tells the vendor about a return, a refund, a contract in force and a contract that ended', async () => {
    await notifier.returnPosted(vendorId, 'PRT-2026-00001', 'PO-2026-00007', 'Damaged in transit');
    await notifier.refundRecorded(vendorId, 'VRF-2026-00001', '120.00', 'KES', 'TT-1');
    await notifier.contractApproved(vendorId, 'CTR-2026-00001', 'Panels 2026', '2026-01-01', '2026-12-31');
    await notifier.contractEnded(vendorId, 'CTR-2026-00001', 'Prices changed');
    const to = (subject: string) => outbox.sent.filter((m) => m.subject.startsWith(subject));
    expect(to('Goods returned to you: PRT-2026-00001')).toHaveLength(1);
    expect(to('Goods returned to you')[0]?.text).toContain('Damaged in transit');
    expect(to('Goods returned to you')[0]?.to).toBe(`vn.${run}@example.test`);
    expect(to('Refund received: VRF-2026-00001')[0]?.text).toContain('120.00 KES');
    expect(to('Contract CTR-2026-00001 is in force')[0]?.text).toContain('2026-12-31');
    expect(to('Contract CTR-2026-00001 has ended')[0]?.text).toContain('Prices changed');
  });

  it('tells the person who wrote a requisition, at their own address, and says nothing for an unknown or non-user writer', async () => {
    const [u] = await db.insert(schema.users).values({ email: `req.${run}@example.test`, passwordHash: 'x', name: 'Asker', role: 'manager' }).returning();
    await notifier.requisitionDecided(required(u).id, 'PRQ-2026-00001', 'Office desks', 'sent_back', 'Say how many');
    const mail = outbox.sent.find((m) => m.subject.startsWith('Requisition PRQ-2026-00001'));
    expect(mail?.to).toBe(`req.${run}@example.test`);
    expect(mail?.subject).toContain('was sent back to you');
    expect(mail?.text).toContain('Say how many');
    const before = outbox.sent.length;
    await notifier.requisitionDecided('asker', 'PRQ-2026-00002', 'x', 'approved', null);
    await notifier.requisitionDecided(randomUUID(), 'PRQ-2026-00002', 'x', 'approved', null);
    await notifier.requisitionDecided(null, 'PRQ-2026-00002', 'x', 'approved', null);
    expect(outbox.sent).toHaveLength(before);
  });
});
