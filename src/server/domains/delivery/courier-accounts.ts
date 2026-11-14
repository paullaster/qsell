import { randomBytes } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { courierAccounts, type CourierAccountRow } from '@/server/db/drizzle/schema';
import { checkHttpSettings, type HttpCourierSettings } from '@/lib/courier-http';
import { ADAPTER_WORDS, courierAdapter, isAdapterId, type CourierAdapterId } from '@/server/adapters/courier/registry';
import { CourierError, type CourierPort } from '@/server/adapters/courier/port';
import { decryptCredentials, encryptCredentials } from '@/server/domains/payments/crypto';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { DocActor, DocRefusal, DocResult } from './documents';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (reason: DocRefusal, message: string): { ok: false; reason: DocRefusal; message: string } => ({ ok: false, reason, message });
const secretText = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' && v.length <= 500 && !/[\r\n\0]/.test(v) ? v.trim() : null);

export interface CourierAccountView {
  id: string;
  name: string;
  adapter: CourierAdapterId;
  adapterWords: string;
  baseUrl: string | null;
  authHeader: string | null;
  bookPath: string | null;
  trackPath: string | null;
  cancelPath: string | null;
  cancelMethod: 'DELETE' | 'POST' | null;
  /** The mapping of the courier's answers, as JSON text for the form. */
  mapping: string;
  /** Whether a key is kept. The key itself is never shown. */
  hasKey: boolean;
  /** The address the courier pushes its news to, relative to the shop's address. */
  webhookPath: string;
  isActive: boolean;
  /** What the last test parcel did, in words; null until one is sent. Never carries the key. */
  lastTest: { at: string; booked: boolean; cancelled: boolean; message: string } | null;
  version: number;
}

/** What the worker needs to talk to a courier: opened only where a call is made, never returned to a screen. */
export interface Connection {
  accountId: string;
  name: string;
  adapter: CourierAdapterId;
  settings: HttpCourierSettings | null;
  key: string | null;
  webhookSecret: string | null;
}

/** What a test parcel did, in words that are safe to show: nothing of the courier's own error text, and never the key. */
export interface TestParcelResult {
  booked: boolean;
  /** The courier's answer, or why the booking did not work. */
  message: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  labelUrl: string | null;
  /** Whether the test booking was taken back with the courier straight after. */
  cancelled: boolean;
  cancelMessage: string | null;
}

class Refused extends Error {
  constructor(readonly refusal: { ok: false; reason: DocRefusal; message: string }) {
    super(refusal.message);
  }
}

/**
 * The couriers the company sends parcels with. A courier's key and the secret its news is signed with are sealed when saved and opened only where a
 * call is made or a signature is checked; nothing here returns them, and the decision log never holds them. A new secret is shown once, when made.
 */
export class CourierAccounts {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly adapterFor: (c: Connection) => CourierPort = (c) => courierAdapter(c.adapter, c.settings === null || c.key === null ? undefined : { settings: c.settings, key: c.key }),
  ) {}

  private view(a: CourierAccountRow): CourierAccountView {
    const s = a.settings as Partial<HttpCourierSettings>;
    const http = a.adapter === 'http_json';
    return {
      id: a.id,
      name: a.name,
      adapter: a.adapter,
      adapterWords: ADAPTER_WORDS[a.adapter],
      baseUrl: http ? (s.baseUrl ?? null) : null,
      authHeader: http ? (s.authHeader ?? null) : null,
      bookPath: http ? (s.bookPath ?? null) : null,
      trackPath: http ? (s.trackPath ?? null) : null,
      cancelPath: http ? (s.cancelPath ?? null) : null,
      cancelMethod: http ? (s.cancelMethod ?? null) : null,
      mapping: http && s.mapping !== undefined ? JSON.stringify(s.mapping, null, 2) : '',
      hasKey: a.secretsSealed !== null,
      webhookPath: `/api/couriers/${a.webhookKey}`,
      isActive: a.isActive,
      lastTest: a.lastTestAt === null || a.lastTestBooked === null || a.lastTestCancelled === null || a.lastTestMessage === null ? null : { at: a.lastTestAt.toISOString(), booked: a.lastTestBooked, cancelled: a.lastTestCancelled, message: a.lastTestMessage },
      version: a.version,
    };
  }

  private async run<T>(work: Parameters<DrizzleDb['transaction']>[0] extends (tx: infer Tx) => unknown ? (tx: Tx) => Promise<DocResult<T>> : never): Promise<DocResult<T>> {
    try {
      return await this.db.transaction(work);
    } catch (e) {
      if (e instanceof Refused) return e.refusal;
      throw e;
    }
  }

  async list(companyId: string): Promise<CourierAccountView[]> {
    const rows = await this.db.select().from(courierAccounts).where(eq(courierAccounts.companyId, companyId)).orderBy(asc(courierAccounts.name)).limit(200);
    return rows.map((r) => this.view(r));
  }

  /** The courier's connection, opened for a call. Null when it is not there, is stopped, or its key cannot be opened. */
  async connectionFor(companyId: string, accountId: string): Promise<Connection | null> {
    if (!UUID.test(accountId)) return null;
    const [a] = await this.db.select().from(courierAccounts).where(and(eq(courierAccounts.id, accountId), eq(courierAccounts.companyId, companyId)));
    return a === undefined ? null : this.open(a);
  }

  /**
   * Books one parcel that is plainly marked as a test with the courier's own system, to find out whether the address, the key and the mapping
   * of its answers work before a customer's parcel depends on them, then asks the courier to cancel it. It creates no delivery and costs
   * nothing here, but the courier may still see (and, if it charges for bookings, count) the booking, which is why the screen asks first.
   * The answer is data either way: a courier that refuses or cannot be reached is a finding, not an error.
   */
  async testParcel(actor: DocActor, accountId: string, tag: string = randomBytes(3).toString('hex').toUpperCase()): Promise<DocResult<TestParcelResult>> {
    const conn = await this.connectionFor(actor.companyId, accountId);
    if (conn === null) return fail('not_allowed', 'This courier\'s connection is not complete: check its address and key, then try again.');
    if (conn.adapter === 'manual') return fail('not_allowed', 'A courier typed in by hand has no system to test.');
    const port = this.adapterFor(conn);
    let result: TestParcelResult;
    try {
      const booked = await port.book({ deliveryNumber: `TEST-${tag}`, courierName: conn.name, trackingNumber: null, recipientName: 'TEST PARCEL - DO NOT COLLECT', recipientPhone: null, destination: 'Test booking from the shop, please ignore', parcels: 1 });
      result = { booked: true, message: booked.trackingNumber === null ? 'The courier accepted the booking.' : `The courier accepted the booking and gave tracking number ${booked.trackingNumber}.`, trackingNumber: booked.trackingNumber, trackingUrl: booked.trackingUrl, labelUrl: booked.labelUrl, cancelled: false, cancelMessage: null };
    } catch (e) {
      result = { booked: false, message: e instanceof CourierError ? e.message : 'The courier could not be reached.', trackingNumber: null, trackingUrl: null, labelUrl: null, cancelled: false, cancelMessage: null };
    }
    if (result.booked && result.trackingNumber !== null) {
      try {
        await port.cancel(result.trackingNumber);
        result.cancelled = true;
      } catch (e) {
        result.cancelMessage = `The test booking could not be cancelled${e instanceof CourierError ? ` (${e.message})` : ''}. Cancel it in the courier's own system.`;
      }
    } else if (result.booked) {
      result.cancelMessage = 'The courier gave no tracking number, so the test booking could not be cancelled. Cancel it in the courier\'s own system.';
    }
    await this.decisions.record({ companyId: actor.companyId, subject: { type: 'courier_account', id: conn.accountId }, action: 'courier.test_parcel', actor: { type: 'user', id: actor.userId }, outcome: { booked: result.booked, cancelled: result.cancelled, tracking: result.trackingNumber } });
    // Kept on the account so the card can say what the last test did. Not a change of settings, so the version stays.
    const after = result.cancelled ? 'It was cancelled again straight after.' : (result.cancelMessage ?? '');
    const said = [result.message, result.booked ? after : ''].filter((t) => t !== '').join(' ').slice(0, 500);
    await this.db.update(courierAccounts).set({ lastTestAt: new Date(), lastTestBooked: result.booked, lastTestCancelled: result.cancelled, lastTestMessage: said }).where(and(eq(courierAccounts.id, conn.accountId), eq(courierAccounts.companyId, actor.companyId)));
    return { ok: true, data: result };
  }

  /** The connection a pushed message names: found by the unguessable key in its address. */
  async connectionForWebhook(webhookKey: string): Promise<(Connection & { companyId: string }) | null> {
    if (!/^[0-9a-f]{48}$/.test(webhookKey)) return null;
    const [a] = await this.db.select().from(courierAccounts).where(eq(courierAccounts.webhookKey, webhookKey));
    if (a === undefined) return null;
    const c = this.open(a);
    return c === null ? null : { ...c, companyId: a.companyId };
  }

  private open(a: CourierAccountRow): Connection | null {
    if (a.adapter === 'manual') return { accountId: a.id, name: a.name, adapter: 'manual', settings: null, key: null, webhookSecret: null };
    if (a.secretsSealed === null) return null;
    const checked = checkHttpSettings(a.settings);
    if (!checked.ok) return null;
    try {
      const opened = decryptCredentials(a.secretsSealed) ?? {};
      const key = typeof opened.key === 'string' ? opened.key : null;
      const webhookSecret = typeof opened.webhookSecret === 'string' ? opened.webhookSecret : null;
      return key === null ? null : { accountId: a.id, name: a.name, adapter: 'http_json', settings: checked.settings, key, webhookSecret };
    } catch {
      return null;
    }
  }

  async create(actor: DocActor, input: Record<string, unknown>): Promise<DocResult<{ account: CourierAccountView; webhookSecret: string | null }>> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 2 || name.length > 80) return fail('bad_input', 'Give the courier\'s name, between 2 and 80 letters.');
    if (!isAdapterId(input.adapter)) return fail('bad_input', 'Say how the courier is connected.');
    const adapter = input.adapter;
    let settings: Record<string, unknown> = {};
    let sealed: ReturnType<typeof encryptCredentials> | null = null;
    let webhookSecret: string | null = null;
    if (adapter === 'http_json') {
      const checked = checkHttpSettings(input);
      if (!checked.ok) return fail('bad_input', checked.error);
      const key = secretText(input.apiKey);
      if (key === null) return fail('bad_input', 'Give the key the courier gave you.');
      settings = { ...checked.settings };
      webhookSecret = randomBytes(24).toString('hex');
      sealed = encryptCredentials({ key, webhookSecret });
    }
    return await this.run(async (tx) => {
      const [made] = await tx
        .insert(courierAccounts)
        .values({ companyId: actor.companyId, name, adapter, settings, secretsSealed: sealed, webhookKey: randomBytes(24).toString('hex'), createdBy: actor.userId })
        .onConflictDoNothing()
        .returning();
      if (made === undefined) return fail('conflict', `There is already a courier called "${name}".`);
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'courier_account', id: made.id }, action: 'courier.account_created', actor: { type: 'user', id: actor.userId }, inputs: { name, adapter, baseUrl: adapter === 'http_json' ? settings.baseUrl : null } }, tx);
      return { ok: true, data: { account: this.view(made), webhookSecret } };
    });
  }

  async update(actor: DocActor, id: string, input: Record<string, unknown>): Promise<DocResult<CourierAccountView>> {
    if (!UUID.test(id)) return fail('not_found', 'That courier could not be found.');
    const expected = typeof input.expectedVersion === 'number' ? input.expectedVersion : null;
    return await this.run(async (tx) => {
      const [a] = await tx.select().from(courierAccounts).where(and(eq(courierAccounts.id, id), eq(courierAccounts.companyId, actor.companyId))).for('update');
      if (a === undefined) return fail('not_found', 'That courier could not be found.');
      if (expected !== null && expected !== a.version) return fail('conflict', 'Someone else changed this courier. Reload and try again.');
      const name = typeof input.name === 'string' ? input.name.trim() : a.name;
      if (name.length < 2 || name.length > 80) return fail('bad_input', 'Give the courier\'s name, between 2 and 80 letters.');
      let settings = a.settings;
      let sealed = a.secretsSealed;
      const changed: string[] = [];
      if (a.adapter === 'http_json') {
        const checked = checkHttpSettings({ ...a.settings, mapping: JSON.stringify((a.settings as Partial<HttpCourierSettings>).mapping), ...input });
        if (!checked.ok) return fail('bad_input', checked.error);
        settings = { ...checked.settings };
        const newKey = input.apiKey === undefined || input.apiKey === '' ? null : secretText(input.apiKey);
        if (input.apiKey !== undefined && input.apiKey !== '' && newKey === null) return fail('bad_input', 'That key cannot be used.');
        if (newKey !== null && sealed !== null) {
          const opened = decryptCredentials(sealed) ?? {};
          sealed = encryptCredentials({ key: newKey, webhookSecret: typeof opened.webhookSecret === 'string' ? opened.webhookSecret : randomBytes(24).toString('hex') });
          changed.push('key');
        }
        if (JSON.stringify(settings) !== JSON.stringify(a.settings)) changed.push('settings');
      }
      if (name !== a.name) changed.push('name');
      const saved = await tx
        .update(courierAccounts)
        .set({ name, settings, secretsSealed: sealed, version: a.version + 1, updatedBy: actor.userId, updatedAt: new Date() })
        .where(and(eq(courierAccounts.id, id), eq(courierAccounts.version, a.version)))
        .returning()
        .catch((e: unknown) => {
          if ((e as { code?: string; cause?: { code?: string } }).code === '23505' || (e as { cause?: { code?: string } }).cause?.code === '23505') throw new Refused(fail('conflict', `There is already a courier called "${name}".`));
          throw e;
        });
      const row = saved[0];
      if (row === undefined) return fail('conflict', 'Someone else changed this courier. Reload and try again.');
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'courier_account', id }, action: 'courier.account_changed', actor: { type: 'user', id: actor.userId }, inputs: { changed } }, tx);
      return { ok: true, data: this.view(row) };
    });
  }

  async setActive(actor: DocActor, id: string, active: boolean, expectedVersion?: number): Promise<DocResult<CourierAccountView>> {
    if (!UUID.test(id)) return fail('not_found', 'That courier could not be found.');
    return await this.run(async (tx) => {
      const [a] = await tx.select().from(courierAccounts).where(and(eq(courierAccounts.id, id), eq(courierAccounts.companyId, actor.companyId))).for('update');
      if (a === undefined) return fail('not_found', 'That courier could not be found.');
      if (expectedVersion !== undefined && expectedVersion !== a.version) return fail('conflict', 'Someone else changed this courier. Reload and try again.');
      const [row] = await tx.update(courierAccounts).set({ isActive: active, version: a.version + 1, updatedBy: actor.userId, updatedAt: new Date() }).where(eq(courierAccounts.id, id)).returning();
      if (row === undefined) return fail('not_found', 'That courier could not be found.');
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'courier_account', id }, action: active ? 'courier.account_started' : 'courier.account_stopped', actor: { type: 'user', id: actor.userId }, inputs: {} }, tx);
      return { ok: true, data: this.view(row) };
    });
  }

  /** A new secret for the courier to sign its news with. Shown once; the old one stops working at once. */
  async newWebhookSecret(actor: DocActor, id: string): Promise<DocResult<{ webhookSecret: string }>> {
    if (!UUID.test(id)) return fail('not_found', 'That courier could not be found.');
    return await this.run(async (tx) => {
      const [a] = await tx.select().from(courierAccounts).where(and(eq(courierAccounts.id, id), eq(courierAccounts.companyId, actor.companyId))).for('update');
      if (a === undefined) return fail('not_found', 'That courier could not be found.');
      if (a.adapter !== 'http_json' || a.secretsSealed === null) return fail('wrong_method', 'Only a courier connected to its own system has a secret for its news.');
      const opened = decryptCredentials(a.secretsSealed) ?? {};
      const webhookSecret = randomBytes(24).toString('hex');
      await tx.update(courierAccounts).set({ secretsSealed: encryptCredentials({ key: typeof opened.key === 'string' ? opened.key : '', webhookSecret }), version: a.version + 1, updatedBy: actor.userId, updatedAt: new Date() }).where(eq(courierAccounts.id, id));
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'courier_account', id }, action: 'courier.secret_renewed', actor: { type: 'user', id: actor.userId }, inputs: {} }, tx);
      return { ok: true, data: { webhookSecret } };
    });
  }
}
