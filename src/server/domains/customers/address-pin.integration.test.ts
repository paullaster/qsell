import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppContainer } from '@/server/di/container';
import type * as Schema from '@/server/db/drizzle/schema';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import { emptyCustomerForm, newCustomerPayload } from '@/lib/customer-forms';

/**
 * A saved delivery address keeps the place on the map the shopper chose for it: stored to six places, both or neither, kept when the
 * address is changed in ways that do not move it and dropped when its words change without a new place.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('saved address with its place on the map (database)', () => {
  let c: AppContainer;
  let db: typeof Db;
  let schema: typeof Schema;
  let companyId = '';
  const tag = randomUUID().slice(0, 6);

  const customer = async (): Promise<string> => {
    const checked = newCustomerPayload({ ...emptyCustomerForm(), accountType: 'cash' as const, name: `Pin ${tag}`, email: `pin-${randomUUID().slice(0, 8)}@example.test` });
    if (!checked.ok) throw new Error(checked.error);
    return (await c.customers.saveCustomer(companyId, { ...checked.payload, blocked: 'none' })).id;
  };
  const base = { label: 'Home', recipientName: 'Wanjiru', recipientPhone: '0711000111', street: '12 Moi Avenue', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya' };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
  });

  it('keeps the place with the address, to six places, and has none for an address that was only written', async () => {
    const id = await customer();
    const pinned = await c.customers.addAddress(id, { ...base, latitude: -1.29210049, longitude: 36.8219 });
    expect(pinned).toMatchObject({ latitude: '-1.292100', longitude: '36.821900' });
    const written = await c.customers.addAddress(id, { ...base, label: 'Office', street: '5 Kimathi Street' });
    expect(written).toMatchObject({ latitude: null, longitude: null });
    // Half a place, or one that is not on the earth, is no place: nothing is kept.
    const half = await c.customers.addAddress(id, { ...base, label: 'Half', street: '1 Half Road', latitude: -1.2, longitude: null });
    const far = await c.customers.addAddress(id, { ...base, label: 'Far', street: '2 Far Road', latitude: 95, longitude: 36.8 });
    expect(half).toMatchObject({ latitude: null, longitude: null });
    expect(far).toMatchObject({ latitude: null, longitude: null });
  });

  it('keeps the place when only the label, the phone or the default changes, replaces it when a new one is given, and drops it when the words change without one', async () => {
    const id = await customer();
    const first = await c.customers.addAddress(id, { ...base, latitude: -1.2921, longitude: 36.8219 });
    const relabelled = await c.customers.updateAddress(id, first.id, { label: 'Flat', recipientPhone: '0722000222', street: '  12 MOI avenue ' });
    expect(relabelled).toMatchObject({ label: 'Flat', latitude: '-1.292100', longitude: '36.821900' });
    const moved = await c.customers.updateAddress(id, first.id, { latitude: -1.3001, longitude: 36.7802 });
    expect(moved).toMatchObject({ latitude: '-1.300100', longitude: '36.780200' });
    const reworded = await c.customers.updateAddress(id, first.id, { street: '40 Ngong Road' });
    expect(reworded).toMatchObject({ street: '40 Ngong Road', latitude: null, longitude: null });
    const again = await c.customers.updateAddress(id, first.id, { latitude: -1.31, longitude: 36.79 });
    expect(again).toMatchObject({ latitude: '-1.310000', longitude: '36.790000' });
    const cleared = await c.customers.updateAddress(id, first.id, { latitude: null, longitude: null });
    expect(cleared).toMatchObject({ latitude: null, longitude: null });
  });

  it('does not keep a place that is sent back unchanged beside new words, as the My addresses screen does, but keeps it beside the same words', async () => {
    const id = await customer();
    const first = await c.customers.addAddress(id, { ...base, latitude: -1.2921, longitude: 36.8219 });
    const same = await c.customers.updateAddress(id, first.id, { ...base, label: 'Renamed', latitude: -1.2921, longitude: 36.8219 });
    expect(same).toMatchObject({ label: 'Renamed', latitude: '-1.292100', longitude: '36.821900' });
    const moved = await c.customers.updateAddress(id, first.id, { ...base, street: '99 Elsewhere Road', latitude: -1.2921, longitude: 36.8219 });
    expect(moved).toMatchObject({ street: '99 Elsewhere Road', latitude: null, longitude: null });
    const repinned = await c.customers.updateAddress(id, first.id, { ...base, street: '5 New Place', latitude: -1.3, longitude: 36.78 });
    expect(repinned).toMatchObject({ street: '5 New Place', latitude: '-1.300000', longitude: '36.780000' });
  });

  it('is refused by the database when a place is half there or off the earth', async () => {
    const id = await customer();
    const row = await c.customers.addAddress(id, base);
    await expect(db.update(schema.customerAddresses).set({ latitude: '-1.200000' }).where(eq(schema.customerAddresses.id, row.id))).rejects.toThrow();
    await expect(db.update(schema.customerAddresses).set({ latitude: '91.000000', longitude: '36.800000' }).where(eq(schema.customerAddresses.id, row.id))).rejects.toThrow();
    await expect(db.update(schema.customerAddresses).set({ latitude: '-1.200000', longitude: '181.000000' }).where(eq(schema.customerAddresses.id, row.id))).rejects.toThrow();
    await db.update(schema.customerAddresses).set({ latitude: '-1.200000', longitude: '36.800000' }).where(eq(schema.customerAddresses.id, row.id));
  });
});
