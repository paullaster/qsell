import { and, count, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, paymentAttempts, paymentMethods, paymentProviderConfigs } from '@/server/db/drizzle/schema';
import { decryptCredentials, encryptCredentials, maskCredentials } from '@/server/domains/payments/crypto';
import { darajaSettings } from '@/server/domains/payments/daraja/config';
import { DARAJA_OPERATIONS } from '@/server/domains/payments/daraja/operations';
import { ensureManualProvider } from '@/server/domains/payments/manual-provider';
import type { PaymentConfigRepository } from '@/server/domains/payments/repository';
import type { PaymentService } from '@/server/domains/payments/service';
import { PAYMENT_PROVIDER_META, type PaymentProviderCode, type PaymentProviderEnvironment } from '@/server/domains/payments/types';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { FinanceError, type FinanceContext } from './errors';

import { has } from '@/lib/has';
import { orElse } from '@/lib/values';
import type { DarajaSettings } from '@/server/domains/payments/daraja/config';
import type { FieldSpec } from '@/server/domains/payments/daraja/catalog';

export interface ProviderView {
  id: string;
  providerCode: PaymentProviderCode | 'manual';
  /** The name given to this connection. */
  label: string;
  /** What kind of service it is. */
  service: string;
  description: string;
  isSystem: boolean;
  isEnabled: boolean;
  environment: PaymentProviderEnvironment;
  apiBaseUrl: string;
  hasCredentials: boolean;
  maskedCredentials: Record<string, string> | null;
  capabilities: readonly string[];
  callbackUrl: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  methods: { id: string; name: string; kind: string; enabled: boolean; branchName: string | null; channel: string | null }[];
  /** M-Pesa: how payments are confirmed, who may call us, which operations are on. */
  daraja: null | {
    settings: DarajaSettings;
    operations: { code: string; label: string; description: string; group: string; async: boolean; moneyOut: boolean; needsInitiator: boolean; needsMethod: boolean; internal: boolean; sandboxOnly: boolean; fields: FieldSpec[]; enabled: boolean; maxAmount: string | null }[];
    hasInitiator: boolean;
  };
}

const MANUAL_DESCRIPTION = 'For cash, cheques and bank deposits: no outside company, nothing to connect.';

/**
 * Payment providers: one connection to an outside service (or the built-in Manual one) with the
 * credentials every payment method under it shares. They belong to the company. The branch, bank
 * account, G/L account and paybill or till number are chosen on each payment method.
 */
export class PaymentProviderService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly configs: PaymentConfigRepository,
    private readonly payments: PaymentService,
  ) {}

  private async load(companyId: string, id: string) {
    const row = await this.configs.getById(id);
    if (!row || row.companyId !== companyId) throw new FinanceError('NOT_FOUND', 'That provider does not exist.');
    return row;
  }

  private notSystem(row: { isSystem: boolean }) {
    if (row.isSystem) throw new FinanceError('SYSTEM_PROVIDER', 'The Manual provider is built in: it has nothing to configure and cannot be changed or deleted.');
  }

  async list(companyId: string, publicBaseUrl: string | null): Promise<ProviderView[]> {
    await ensureManualProvider(this.db, companyId);
    const rows = await this.configs.listByCompany(companyId);
    const methods = await this.db
      .select({ m: paymentMethods, branchName: branches.name })
      .from(paymentMethods)
      .leftJoin(branches, eq(branches.id, paymentMethods.branchId))
      .where(eq(paymentMethods.companyId, companyId))
      .orderBy(paymentMethods.sortOrder, paymentMethods.code);
    return rows.map((row) => {
      const manual = row.providerCode === 'manual';
      const code = row.providerCode as PaymentProviderCode;
      const meta = manual ? null : PAYMENT_PROVIDER_META[code];
      let masked: Record<string, string> | null = null;
      if (!manual) {
        try {
          masked = maskCredentials(decryptCredentials(row.credentialsEncrypted));
        } catch {
          masked = { _error: 'Saved credentials cannot be opened with the current key.' };
        }
      }
      let creds: Record<string, string> = {};
      try {
        creds = (decryptCredentials(row.credentialsEncrypted) ?? {});
      } catch {
        creds = {};
      }
      const dj = row.providerCode === 'mpesa_daraja' ? darajaSettings(row.settings) : null;
      return {
        id: row.id,
        providerCode: row.providerCode,
        label: row.displayName,
        service: meta?.label ?? 'Manual',
        description: meta?.description ?? MANUAL_DESCRIPTION,
        isSystem: row.isSystem,
        isEnabled: row.isEnabled,
        environment: row.environment,
        apiBaseUrl: row.apiBaseUrl,
        hasCredentials: Boolean(row.credentialsEncrypted),
        maskedCredentials: masked,
        capabilities: manual ? [] : this.payments.capabilitiesOf(code),
        callbackUrl: meta && has(publicBaseUrl) ? `${publicBaseUrl.replace(/\/$/, '')}${meta.callbackPathPrefix}/<per-payment token>` : null,
        lastTestAt: row.lastTestAt ? row.lastTestAt.toISOString() : null,
        lastTestOk: row.lastTestOk,
        lastTestMessage: row.lastTestMessage,
        daraja: dj
          ? {
              settings: dj,
              operations: Object.values(DARAJA_OPERATIONS).map((o) => ({ code: o.code, label: o.label, description: o.description, group: o.group, async: o.async, moneyOut: o.moneyOut, needsInitiator: o.needsInitiator, needsMethod: o.needsMethod, internal: Boolean(o.internal), sandboxOnly: Boolean(o.sandboxOnly), fields: o.fields, enabled: dj.operations[o.code]?.enabled ?? false, maxAmount: dj.operations[o.code]?.maxAmount ?? null })),
              hasInitiator: Boolean(has(creds.initiatorName) && has(creds.initiatorPassword) && creds.certificate),
            }
          : null,
        methods: methods
          .filter((x) => x.m.providerId === row.id)
          .map((x) => ({ id: x.m.id, name: x.m.name, kind: x.m.kind, enabled: x.m.enabled, branchName: x.branchName, channel: has(x.m.channelNumber) ? `${x.m.channelKind ?? 'number'} ${x.m.channelNumber}` : null })),
      };
    });
  }

  async create(ctx: FinanceContext, input: { providerCode: PaymentProviderCode; displayName?: string; environment?: PaymentProviderEnvironment; apiBaseUrl?: string }) {
    const meta = PAYMENT_PROVIDER_META[input.providerCode];
    if (!meta) throw new FinanceError('SERVICE_UNKNOWN', 'Choose which service this provider connects to.');
    const environment = input.environment ?? 'staging';
    const url = (orElse(input.apiBaseUrl?.trim(), environment === 'production' ? meta.defaultProductionBaseUrl : meta.defaultStagingBaseUrl)).replace(/\/$/, '');
    if (!/^https:\/\//i.test(url)) throw new FinanceError('URL_INVALID', 'The provider address must start with https://.');
    const name = orElse(input.displayName?.trim(), meta.label);
    const [dup] = await this.db.select({ id: paymentProviderConfigs.id }).from(paymentProviderConfigs).where(and(eq(paymentProviderConfigs.companyId, ctx.companyId), sql`lower(${paymentProviderConfigs.displayName}) = lower(${name})`));
    if (dup) throw new FinanceError('DUPLICATE', `A provider named "${name}" already exists. Give this one a different name.`);
    const row = await this.configs.create({ companyId: ctx.companyId, providerCode: input.providerCode, displayName: name, environment, apiBaseUrl: url });
    await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'payment_provider', id: row.id }, action: 'finance.payment_provider_created', actor: ctx.actor, inputs: { origin: ctx.origin }, outcome: { service: input.providerCode, name } });
    return { id: row.id };
  }

  async update(ctx: FinanceContext, id: string, input: { displayName?: string; environment?: PaymentProviderEnvironment; apiBaseUrl?: string }) {
    const row = await this.load(ctx.companyId, id);
    this.notSystem(row);
    const url = (input.apiBaseUrl ?? row.apiBaseUrl).trim().replace(/\/$/, '');
    if (!/^https:\/\//i.test(url)) throw new FinanceError('URL_INVALID', 'The provider address must start with https://.');
    const name = orElse(input.displayName?.trim(), row.displayName);
    if (name.toLowerCase() !== row.displayName.toLowerCase()) {
      const [dup] = await this.db.select({ id: paymentProviderConfigs.id }).from(paymentProviderConfigs).where(and(eq(paymentProviderConfigs.companyId, ctx.companyId), sql`lower(${paymentProviderConfigs.displayName}) = lower(${name})`));
      if (dup) throw new FinanceError('DUPLICATE', `A provider named "${name}" already exists.`);
    }
    await this.configs.update(id, { displayName: name, environment: input.environment ?? row.environment, apiBaseUrl: url });
    await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'payment_provider', id }, action: 'finance.payment_provider_updated', actor: ctx.actor, inputs: { origin: ctx.origin, environment: input.environment ?? row.environment, apiBaseUrl: url } });
  }

  /**
   * The non-secret settings of a provider (how payments are confirmed, who may call us, which operations are on).
   * What is saved is the cleaned-up form, so nonsense never reaches the engine.
   */
  async updateSettings(ctx: FinanceContext, id: string, patch: Record<string, unknown>) {
    const row = await this.load(ctx.companyId, id);
    this.notSystem(row);
    const { darajaSettings } = await import('@/server/domains/payments/daraja/config');
    const merged = { ...((row.settings ?? {})) };
    for (const [k, v] of Object.entries(patch)) merged[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...((merged[k]) ?? {}), ...(v as Record<string, unknown>) } : v;
    const clean = row.providerCode === 'mpesa_daraja' ? darajaSettings(merged) : (await import('@/server/domains/payments/engine/settings')).engineSettings(merged);
    for (const cidr of clean.security.allowedCidrs) {
      if (!/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(cidr)) throw new FinanceError('CIDR_INVALID', `"${cidr}" is not an address or range (use 1.2.3.4 or 1.2.3.0/24).`);
    }
    await this.configs.update(id, { settings: { ...merged, ...clean } });
    await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'payment_provider', id }, action: 'finance.payment_provider_settings_changed', actor: ctx.actor, inputs: { origin: ctx.origin, changed: Object.keys(patch) } });
  }

  async setCredentials(ctx: FinanceContext, id: string, credentials: Record<string, string>) {
    const row = await this.load(ctx.companyId, id);
    this.notSystem(row);
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(credentials)) if (typeof v === 'string' && has(v.trim()) && !v.includes('•')) cleaned[k] = v.trim();
    if (Object.keys(cleaned).length === 0) throw new FinanceError('NOTHING_TO_SAVE', 'Enter at least one value to save.');
    const previous = decryptCredentials(row.credentialsEncrypted) ?? {};
    await this.configs.update(id, { credentialsEncrypted: encryptCredentials({ ...previous, ...cleaned }) });
    // Which fields changed is recorded; their values never are.
    await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'payment_provider', id }, action: 'finance.payment_provider_credentials_set', actor: ctx.actor, inputs: { origin: ctx.origin, fields: Object.keys(cleaned) } });
  }

  async setEnabled(ctx: FinanceContext, id: string, enabled: boolean) {
    const row = await this.load(ctx.companyId, id);
    this.notSystem(row);
    if (enabled && !row.credentialsEncrypted) throw new FinanceError('NO_CREDENTIALS', 'Save the credentials and run "Test connection" before switching it on.');
    if (enabled && row.lastTestOk !== true) throw new FinanceError('NOT_TESTED', 'Run "Test connection" successfully before switching this provider on.');
    await this.configs.update(id, { isEnabled: enabled });
    await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'payment_provider', id }, action: enabled ? 'finance.payment_provider_enabled' : 'finance.payment_provider_disabled', actor: ctx.actor, inputs: { origin: ctx.origin } });
  }

  async test(ctx: FinanceContext, id: string) {
    const row = await this.load(ctx.companyId, id);
    this.notSystem(row);
    const result = await this.payments.testConnection(id);
    await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'payment_provider', id }, action: 'finance.payment_provider_tested', actor: ctx.actor, inputs: { origin: ctx.origin }, outcome: { ok: result.ok, message: result.message } });
    return { ok: result.ok, message: result.message, at: result.at.toISOString() };
  }

  async delete(ctx: FinanceContext, id: string) {
    const row = await this.load(ctx.companyId, id);
    this.notSystem(row);
    const [m] = await this.db.select({ n: count() }).from(paymentMethods).where(eq(paymentMethods.providerId, id));
    if ((m?.n ?? 0) > 0) throw new FinanceError('PROVIDER_IN_USE', `${m.n} payment method${m.n === 1 ? ' goes' : 's go'} through this provider. Move or delete ${m.n === 1 ? 'it' : 'them'} first.`);
    const [a] = await this.db.select({ n: count() }).from(paymentAttempts).where(eq(paymentAttempts.providerConfigId, id));
    if ((a?.n ?? 0) > 0) throw new FinanceError('PROVIDER_HAS_PAYMENTS', 'Customers have paid through this provider, so it is kept for the records. Switch it off instead.');
    await this.configs.remove(id);
    await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'payment_provider', id }, action: 'finance.payment_provider_deleted', actor: ctx.actor, inputs: { origin: ctx.origin, name: row.displayName } });
  }
}
