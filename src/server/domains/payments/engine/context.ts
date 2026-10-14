import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { companySettings, paymentProviderConfigs } from '@/server/db/drizzle/schema';
import { decryptCredentials, encryptCredentials, stringFields } from '../crypto';
import { loggedCall } from './http-client';
import { newSecret } from './redact';
import type { PlatformContext } from './types';

/**
 * Opens a provider for use: its credentials (never logged), its settings, and a way to call its
 * platform that records every call. The secret in the addresses a platform calls us back on is
 * made the first time it is needed and kept sealed with the credentials.
 */
export class PlatformContexts {
  constructor(
    private readonly db: DrizzleDb,
    private readonly fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {}

  async forProvider(providerId: string): Promise<PlatformContext> {
    const [provider] = await this.db.select().from(paymentProviderConfigs).where(eq(paymentProviderConfigs.id, providerId));
    if (!provider) throw new Error('That payment provider does not exist.');
    const credentials = stringFields(decryptCredentials(provider.credentialsEncrypted));
    const [company] = await this.db.select({ url: companySettings.publicBaseUrl }).from(companySettings).where(eq(companySettings.id, provider.companyId));
    return {
      companyId: provider.companyId,
      provider,
      credentials,
      settings: (provider.settings ?? {}),
      call: (input) => loggedCall(this.db, { ...input, companyId: provider.companyId, providerId: provider.id }, this.fetchImpl),
      publicBaseUrl: company?.url?.replace(/\/$/, '') ?? null,
      now: () => new Date(),
    };
  }

  /** The secret path segment of this provider's callback addresses; created and sealed on first use. */
  async callbackSecret(providerId: string): Promise<string> {
    const [provider] = await this.db.select().from(paymentProviderConfigs).where(eq(paymentProviderConfigs.id, providerId));
    if (!provider) throw new Error('That payment provider does not exist.');
    const creds = stringFields(decryptCredentials(provider.credentialsEncrypted));
    if (creds.callbackSecret) return creds.callbackSecret;
    const secret = newSecret();
    await this.db
      .update(paymentProviderConfigs)
      .set({ credentialsEncrypted: encryptCredentials({ ...creds, callbackSecret: secret }), updatedAt: new Date() })
      .where(eq(paymentProviderConfigs.id, providerId));
    return secret;
  }

  /** Does the presented secret belong to this provider? (Constant time.) */
  async checkSecret(providerId: string, presented: string): Promise<boolean> {
    const [provider] = await this.db.select({ c: paymentProviderConfigs.credentialsEncrypted }).from(paymentProviderConfigs).where(eq(paymentProviderConfigs.id, providerId));
    if (!provider) return false;
    const creds = stringFields(decryptCredentials(provider.c));
    const known = creds.callbackSecret;
    if (!known || !presented || presented.length !== known.length) return false;
    const { timingSafeEqual } = await import('node:crypto');
    return timingSafeEqual(Buffer.from(presented), Buffer.from(known));
  }
}
