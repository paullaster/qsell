import { eq, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  branchKraConfigs,
  companyKraConfigs,
  type BranchKraConfigRow,
  type CompanyKraConfigRow,
} from '@/server/db/drizzle/schema';
import type { EncryptedCredentialsBlob } from '@/server/domains/payments/types';
import type { KraConfigReader } from './resolver';
import type { ModuleSigning } from './signing/types';
import type { KraEnvironment, KraMode } from './types';

export interface KraConfigWrite {
  mode: KraMode;
  isEnabled: boolean;
  environment: KraEnvironment;
  apiBaseUrl: string | null;
  settings: Record<string, unknown>;
  allowEtimsSigning: boolean;
  allowTimsSigning: boolean;
  moduleSigning: ModuleSigning;
  /** Undefined keeps the stored credentials; null clears them. */
  credentialsEncrypted?: EncryptedCredentialsBlob | null;
}

export class KraConfigRepository implements KraConfigReader {
  constructor(private readonly db: DrizzleDb) {}

  async getCompanyConfig(companyId: string): Promise<CompanyKraConfigRow | null> {
    const rows = await this.db
      .select()
      .from(companyKraConfigs)
      .where(eq(companyKraConfigs.companyId, companyId))
      .limit(1);
    return rows.at(0) ?? null;
  }

  async getBranchConfig(branchId: string): Promise<BranchKraConfigRow | null> {
    const rows = await this.db
      .select()
      .from(branchKraConfigs)
      .where(eq(branchKraConfigs.branchId, branchId))
      .limit(1);
    return rows.at(0) ?? null;
  }

  async getBranchConfigs(branchIds: string[]): Promise<Map<string, BranchKraConfigRow>> {
    if (branchIds.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(branchKraConfigs)
      .where(inArray(branchKraConfigs.branchId, branchIds));
    return new Map(rows.map((r) => [r.branchId, r]));
  }

  async listBranchConfigs(): Promise<BranchKraConfigRow[]> {
    return this.db.select().from(branchKraConfigs);
  }

  async upsertCompanyConfig(
    companyId: string,
    input: KraConfigWrite,
  ): Promise<CompanyKraConfigRow> {
    const { credentialsEncrypted, ...rest } = input;
    const creds = credentialsEncrypted === undefined ? {} : { credentialsEncrypted };
    const [row] = await this.db
      .insert(companyKraConfigs)
      .values({ companyId, ...rest, ...creds })
      .onConflictDoUpdate({
        target: companyKraConfigs.companyId,
        set: { ...rest, ...creds, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }

  async upsertBranchConfig(branchId: string, input: KraConfigWrite): Promise<BranchKraConfigRow> {
    const { credentialsEncrypted, ...rest } = input;
    const creds = credentialsEncrypted === undefined ? {} : { credentialsEncrypted };
    const [row] = await this.db
      .insert(branchKraConfigs)
      .values({ branchId, ...rest, ...creds })
      .onConflictDoUpdate({
        target: branchKraConfigs.branchId,
        set: { ...rest, ...creds, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }
}
