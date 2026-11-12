import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { smsProviderAccounts, type SmsProviderAccountRow } from '@/server/db/drizzle/schema';
import { SMS_PROVIDERS, TEST_MESSAGE, checkProvider, internationalPhone, isSmsProviderId, maskedPhone, smsProviderWords, type SmsField, type SmsProviderId } from '@/lib/sms-providers';
import { smsAdapter } from '@/server/adapters/sms/registry';
import type { Fetch } from '@/server/adapters/sms/http';
import { decryptCredentials, encryptCredentials } from '@/server/domains/payments/crypto';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { SmsSendError, type SmsPort } from '@/server/ports/sms';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A test message may be sent from one account this often: it costs money, and the text is fixed, so the button cannot be used to send anything else. */
const TEST_GAP_SECONDS = 30;
const NAME_TAKEN = 'sms_provider_accounts_name_uidx';

export type SmsRefusal = 'not_found' | 'bad_input' | 'conflict' | 'not_allowed';
export type SmsOutcome<T> = { ok: true; data: T } | { ok: false; reason: SmsRefusal; message: string };
const fail = (reason: SmsRefusal, message: string): { ok: false; reason: SmsRefusal; message: string } => ({ ok: false, reason, message });

export interface SmsActor {
  companyId: string;
  userId: string;
}

export interface SmsAccountView {
  id: string;
  name: string;
  adapter: SmsProviderId;
  adapterWords: string;
  /** The plain settings as saved, for the form. Secrets are never here. */
  values: Record<string, string>;
  /** Which secrets are kept (by field key), so the form can say "saved" without showing anything. */
  secretsKept: string[];
  isDefault: boolean;
  isActive: boolean;
  lastTest: { at: string; ok: boolean; error: string | null } | null;
  version: number;
}

class Refused extends Error {
  constructor(readonly refusal: { ok: false; reason: SmsRefusal; message: string }) {
    super(refusal.message);
  }
}

/** A second connection with a name already in use: the database refuses it, and the driver names the rule under either spelling. */
const isNameTaken = (e: unknown): boolean => {
  const cause = typeof e === 'object' && e !== null && 'cause' in e ? e.cause : e;
  if (typeof cause !== 'object' || cause === null) return false;
  const named = cause as { constraint?: unknown; constraint_name?: unknown };
  return named.constraint === NAME_TAKEN || named.constraint_name === NAME_TAKEN;
};


/**
 * The SMS providers the company has connected, for its settings screen, and the sender the rest of the system asks for. Keys and tokens are
 * sealed when saved and opened only where a message is sent; nothing here returns them, and the decision log holds only which fields
 * changed. Exactly one active account can be the default; the first one connected is made the default so sending works at once.
 */
export class SmsAccounts {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly fetchFn: Fetch | undefined,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private view(a: SmsProviderAccountRow): SmsAccountView {
    let kept: string[] = [];
    if (a.secretsSealed !== null) {
      try {
        kept = Object.keys(decryptCredentials(a.secretsSealed) ?? {});
      } catch {
        kept = [];
      }
    }
    return {
      id: a.id,
      name: a.name,
      adapter: a.adapter,
      adapterWords: smsProviderWords(a.adapter),
      values: a.settings,
      secretsKept: kept,
      isDefault: a.isDefault,
      isActive: a.isActive,
      lastTest: a.lastTestAt === null || a.lastTestOk === null ? null : { at: a.lastTestAt.toISOString(), ok: a.lastTestOk, error: a.lastTestError },
      version: a.version,
    };
  }

  private async run<T>(actor: SmsActor, work: Parameters<DrizzleDb['transaction']>[0] extends (tx: infer Tx) => unknown ? (tx: Tx) => Promise<SmsOutcome<T>> : never): Promise<SmsOutcome<T>> {
    try {
      return await this.db.transaction(async (tx) => {
        // Changes to a company's providers take turns, so "the one default" cannot be broken by two at once.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`sms-accounts:${actor.companyId}`}))`);
        return await work(tx);
      });
    } catch (e) {
      if (e instanceof Refused) return e.refusal;
      if (isNameTaken(e)) return fail('conflict', 'There is already an SMS connection with that name.');
      throw e;
    }
  }

  async list(companyId: string): Promise<SmsAccountView[]> {
    const rows = await this.db.select().from(smsProviderAccounts).where(eq(smsProviderAccounts.companyId, companyId)).orderBy(asc(smsProviderAccounts.name)).limit(100);
    return rows.map((r) => this.view(r));
  }

  /** The sender for an account, from its saved settings and opened secrets. Null when it is missing, stopped, half set, or its secrets cannot be opened. */
  private open(a: SmsProviderAccountRow): SmsPort | null {
    if (!a.isActive) return null;
    try {
      const secrets = a.secretsSealed === null ? {} : (decryptCredentials(a.secretsSealed) ?? {});
      const plain: Record<string, string> = {};
      for (const [k, v] of Object.entries(secrets)) if (typeof v === 'string') plain[k] = v;
      return smsAdapter(a.adapter, a.settings, plain, this.fetchFn);
    } catch {
      return null;
    }
  }

  /** The sender the company's messages go through: its default account. Null when there is none, so callers can say "no SMS provider is set up". */
  async defaultSender(companyId: string): Promise<SmsPort | null> {
    const [a] = await this.db.select().from(smsProviderAccounts).where(and(eq(smsProviderAccounts.companyId, companyId), eq(smsProviderAccounts.isDefault, true)));
    return a === undefined ? null : this.open(a);
  }

  async create(actor: SmsActor, input: Record<string, unknown>): Promise<SmsOutcome<SmsAccountView>> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 2 || name.length > 80) return fail('bad_input', 'Give this connection a name, between 2 and 80 letters.');
    if (!isSmsProviderId(input.adapter)) return fail('bad_input', 'Choose the SMS provider.');
    const adapter = input.adapter;
    const checked = checkProvider(adapter, input, { keepSecrets: false });
    if (!checked.ok) return fail('bad_input', checked.error);
    const sealed = Object.keys(checked.secrets).length === 0 ? null : encryptCredentials(checked.secrets);
    return await this.run(actor, async (tx) => {
      const [existing] = await tx.select({ id: smsProviderAccounts.id }).from(smsProviderAccounts).where(and(eq(smsProviderAccounts.companyId, actor.companyId), eq(smsProviderAccounts.isDefault, true)));
      const [made] = await tx
        .insert(smsProviderAccounts)
        .values({ companyId: actor.companyId, name, adapter, settings: checked.settings, secretsSealed: sealed, isDefault: existing === undefined, createdBy: actor.userId })
        .returning();
      if (made === undefined) throw new Error('The provider was not saved.');
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'sms_provider_account', id: made.id }, action: 'sms.account_created', actor: { type: 'user', id: actor.userId }, inputs: { name, adapter, default: made.isDefault } }, tx);
      return { ok: true, data: this.view(made) };
    });
  }

  async update(actor: SmsActor, id: string, input: Record<string, unknown>): Promise<SmsOutcome<SmsAccountView>> {
    if (!UUID.test(id)) return fail('not_found', 'That SMS connection could not be found.');
    return await this.run(actor, async (tx) => {
      const [a] = await tx.select().from(smsProviderAccounts).where(and(eq(smsProviderAccounts.id, id), eq(smsProviderAccounts.companyId, actor.companyId))).for('update');
      if (a === undefined) return fail('not_found', 'That SMS connection could not be found.');
      if (typeof input.expectedVersion === 'number' && input.expectedVersion !== a.version) return fail('conflict', 'Someone else changed this connection. Reload and try again.');
      const name = typeof input.name === 'string' ? input.name.trim() : a.name;
      if (name.length < 2 || name.length > 80) return fail('bad_input', 'Give this connection a name, between 2 and 80 letters.');
      // What the request does not mention stays as saved; a field sent empty is cleared (and refused if the provider needs it).
      const checked = checkProvider(a.adapter, { ...a.settings, ...input }, { keepSecrets: true });
      if (!checked.ok) return fail('bad_input', checked.error);
      let sealed = a.secretsSealed;
      const changed: string[] = [];
      if (Object.keys(checked.secrets).length > 0) {
        const old = a.secretsSealed === null ? {} : (decryptCredentials(a.secretsSealed) ?? {});
        sealed = encryptCredentials({ ...old, ...checked.secrets });
        changed.push(...Object.keys(checked.secrets));
      }
      for (const f of SMS_PROVIDERS[a.adapter].fields.filter((x: SmsField) => !x.secret)) if (checked.settings[f.key] !== a.settings[f.key]) changed.push(f.key);
      if (name !== a.name) changed.push('name');
      const credentialsChanged = changed.some((k) => k !== 'name');
      const [row] = await tx
        .update(smsProviderAccounts)
        .set({ name, settings: checked.settings, secretsSealed: sealed, version: a.version + 1, updatedBy: actor.userId, updatedAt: this.clock(), ...(credentialsChanged ? { lastTestAt: null, lastTestOk: null, lastTestError: null } : {}) })
        .where(and(eq(smsProviderAccounts.id, id), eq(smsProviderAccounts.version, a.version)))
        .returning();
      if (row === undefined) return fail('conflict', 'Someone else changed this connection. Reload and try again.');
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'sms_provider_account', id }, action: 'sms.account_changed', actor: { type: 'user', id: actor.userId }, inputs: { changed } }, tx);
      return { ok: true, data: this.view(row) };
    });
  }

  async setActive(actor: SmsActor, id: string, active: boolean, expectedVersion?: number): Promise<SmsOutcome<SmsAccountView>> {
    if (!UUID.test(id)) return fail('not_found', 'That SMS connection could not be found.');
    return await this.run(actor, async (tx) => {
      const [a] = await tx.select().from(smsProviderAccounts).where(and(eq(smsProviderAccounts.id, id), eq(smsProviderAccounts.companyId, actor.companyId))).for('update');
      if (a === undefined) return fail('not_found', 'That SMS connection could not be found.');
      if (expectedVersion !== undefined && expectedVersion !== a.version) return fail('conflict', 'Someone else changed this connection. Reload and try again.');
      const [row] = await tx.update(smsProviderAccounts).set({ isActive: active, isDefault: active ? a.isDefault : false, version: a.version + 1, updatedBy: actor.userId, updatedAt: this.clock() }).where(eq(smsProviderAccounts.id, id)).returning();
      if (row === undefined) return fail('not_found', 'That SMS connection could not be found.');
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'sms_provider_account', id }, action: active ? 'sms.account_started' : 'sms.account_stopped', actor: { type: 'user', id: actor.userId }, inputs: { wasDefault: a.isDefault && !active } }, tx);
      return { ok: true, data: this.view(row) };
    });
  }

  /** Makes this the connection messages are sent through. Only an active one can be. */
  async setDefault(actor: SmsActor, id: string, expectedVersion?: number): Promise<SmsOutcome<SmsAccountView>> {
    if (!UUID.test(id)) return fail('not_found', 'That SMS connection could not be found.');
    return await this.run(actor, async (tx) => {
      const [a] = await tx.select().from(smsProviderAccounts).where(and(eq(smsProviderAccounts.id, id), eq(smsProviderAccounts.companyId, actor.companyId))).for('update');
      if (a === undefined) return fail('not_found', 'That SMS connection could not be found.');
      if (expectedVersion !== undefined && expectedVersion !== a.version) return fail('conflict', 'Someone else changed this connection. Reload and try again.');
      if (!a.isActive) return fail('not_allowed', 'This connection is stopped. Use it again first, then make it the one messages go through.');
      await tx.update(smsProviderAccounts).set({ isDefault: false, version: sql`${smsProviderAccounts.version} + 1`, updatedAt: this.clock() }).where(and(eq(smsProviderAccounts.companyId, actor.companyId), eq(smsProviderAccounts.isDefault, true), ne(smsProviderAccounts.id, id)));
      const [row] = await tx.update(smsProviderAccounts).set({ isDefault: true, version: a.version + 1, updatedBy: actor.userId, updatedAt: this.clock() }).where(eq(smsProviderAccounts.id, id)).returning();
      if (row === undefined) return fail('not_found', 'That SMS connection could not be found.');
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'sms_provider_account', id }, action: 'sms.account_made_default', actor: { type: 'user', id: actor.userId }, inputs: {} }, tx);
      return { ok: true, data: this.view(row) };
    });
  }

  /**
   * Sends the fixed test message to a number the person types, through this connection, and keeps whether it went. The words cannot be
   * changed (so it cannot be used to send anything else), and a connection can be tested only every half minute. The number is not kept.
   */
  async sendTest(actor: SmsActor, id: string, input: { to: unknown; shopName: string }): Promise<SmsOutcome<SmsAccountView>> {
    if (!UUID.test(id)) return fail('not_found', 'That SMS connection could not be found.');
    const to = internationalPhone(input.to);
    if (to === null) return fail('bad_input', 'Type a mobile phone number, for example 0712 345 678.');
    const claimed = await this.run<SmsProviderAccountRow>(actor, async (tx) => {
      const [a] = await tx.select().from(smsProviderAccounts).where(and(eq(smsProviderAccounts.id, id), eq(smsProviderAccounts.companyId, actor.companyId))).for('update');
      if (a === undefined) return fail('not_found', 'That SMS connection could not be found.');
      if (!a.isActive) return fail('not_allowed', 'This connection is stopped. Use it again to send a test.');
      const now = this.clock();
      if (a.lastTestAt !== null && now.getTime() - a.lastTestAt.getTime() < TEST_GAP_SECONDS * 1000) return fail('not_allowed', `A test was sent a moment ago. Wait ${String(TEST_GAP_SECONDS)} seconds and try again.`);
      const [row] = await tx.update(smsProviderAccounts).set({ lastTestAt: now, lastTestOk: false, lastTestError: 'Waiting for the provider to answer.' }).where(eq(smsProviderAccounts.id, id)).returning();
      return row === undefined ? fail('not_found', 'That SMS connection could not be found.') : { ok: true, data: row };
    });
    if (!claimed.ok) return claimed;
    const sender = this.open(claimed.data);
    let error: string | null = null;
    if (sender === null) error = 'This connection is missing something it needs. Open it, fill in every field and save.';
    else {
      try {
        await sender.send({ to, text: TEST_MESSAGE(input.shopName) });
      } catch (e) {
        if (e instanceof SmsSendError) error = e.message;
        else {
          console.error('[sms] test failed', e);
          error = 'The message could not be sent.';
        }
      }
    }
    const [done] = await this.db.update(smsProviderAccounts).set({ lastTestOk: error === null, lastTestError: error }).where(eq(smsProviderAccounts.id, id)).returning();
    await this.decisions.record({ companyId: actor.companyId, subject: { type: 'sms_provider_account', id }, action: 'sms.test_sent', actor: { type: 'user', id: actor.userId }, inputs: { to: maskedPhone(to), ok: error === null } });
    return done === undefined ? fail('not_found', 'That SMS connection could not be found.') : { ok: true, data: this.view(done) };
  }
}
