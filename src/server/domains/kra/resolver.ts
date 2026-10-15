import { decryptCredentials } from '@/server/domains/payments/crypto';
import type { EncryptedCredentialsBlob } from '@/server/domains/payments/types';
import type { ModuleSigning } from './signing/types';
import {
  KRA_MODES,
  KraConfigError,
  type EtimsCredentials,
  type KraConfigSource,
  type KraEnvironment,
  type KraMode,
  type ResolvedKraConfig,
  type TimsSettings,
} from './types';

import { has } from '@/lib/values';

/** Shape shared by company and branch config rows. */
export interface KraConfigRecord {
  mode: KraMode | string;
  isEnabled: boolean;
  environment: KraEnvironment;
  apiBaseUrl: string | null;
  credentialsEncrypted: EncryptedCredentialsBlob | null;
  settings: Record<string, unknown>;
  allowEtimsSigning: boolean;
  allowTimsSigning: boolean;
  moduleSigning: ModuleSigning;
}

export interface KraConfigReader {
  getCompanyConfig(companyId: string): Promise<KraConfigRecord | null>;
  getBranchConfig(branchId: string): Promise<KraConfigRecord | null>;
  /** One query for many branches; branches without a row are absent from the map. */
  getBranchConfigs(branchIds: string[]): Promise<Map<string, KraConfigRecord>>;
}

export interface KraBranchLookup {
  getById(id: string): Promise<{
    id: string;
    companyId: string;
    isActive: boolean;
    actsIndependently: boolean;
  } | null>;
}

export interface KraResolveTarget {
  companyId: string;
  /** Null/undefined means the transaction is not tied to a branch: company config applies. */
  branchId?: string | null;
}

/**
 * What a configuration source is set to, without throwing. `mode` is known whenever a row
 * exists, even if the row is unusable, so callers can decide whether eTIMS (or TIMS)
 * features belong on screen at all. `mode` null means nothing is configured.
 */
export interface KraConfigInspection {
  source: KraConfigSource;
  branchId: string | null;
  mode: KraMode | null;
  usable: boolean;
  /** The resolver's hard-fail message when not usable. */
  reason: string | null;
}

/**
 * Picks exactly one KRA configuration source and fails hard if it is unusable.
 *
 * - Branch with acts_independently = true → reads ONLY branch_kra_configs. Missing, disabled
 *   or incomplete config throws; there is deliberately no fallback to the company config.
 * - Any other branch, or no branch → reads ONLY company_kra_configs; the branch config
 *   table is never queried.
 */
export class KraConfigResolver {
  constructor(
    private readonly branches: KraBranchLookup,
    private readonly configs: KraConfigReader,
  ) {}

  async resolve(target: KraResolveTarget): Promise<ResolvedKraConfig> {
    let companyId = target.companyId;

    if (has(target.branchId)) {
      const branch = await this.branches.getById(target.branchId);
      if (!branch) {
        throw new KraConfigError('BRANCH_NOT_FOUND', `Branch ${target.branchId} not found.`);
      }
      if (!branch.isActive) {
        throw new KraConfigError('BRANCH_INACTIVE', `Branch ${branch.id} is inactive.`);
      }
      if (branch.actsIndependently) {
        const record = await this.configs.getBranchConfig(branch.id);
        if (!record) {
          throw new KraConfigError(
            'BRANCH_CONFIG_MISSING',
            `Branch ${branch.id} acts independently but has no KRA configuration.`,
            'branch',
          );
        }
        return this.validateRecord(record, 'branch', branch.id);
      }
      companyId = branch.companyId;
    }

    const record = await this.configs.getCompanyConfig(companyId);
    if (!record) {
      throw new KraConfigError(
        'COMPANY_CONFIG_MISSING',
        'No company-level KRA configuration exists.',
        'company',
      );
    }
    return this.validateRecord(record, 'company', null);
  }

  /**
   * Resolves an exact, previously recorded scope instead of working the scope out from a
   * branch's current independence. Used when a document must go back to the gateway that
   * already holds its original (a credit note): today's `acts_independently` is irrelevant,
   * and there is no fallback to the other scope. Reads only that scope's row; a missing,
   * disabled or incomplete one is a hard fail.
   */
  async resolveExplicit(target: {
    companyId: string;
    source: KraConfigSource;
    branchId?: string | null;
  }): Promise<ResolvedKraConfig> {
    if (target.source === 'branch') {
      if (!has(target.branchId)) {
        throw new KraConfigError('BRANCH_NOT_FOUND', 'A branch scope needs a branch.', 'branch');
      }
      const branch = await this.branches.getById(target.branchId);
      if (!branch || branch.companyId !== target.companyId) {
        throw new KraConfigError('BRANCH_NOT_FOUND', `Branch ${target.branchId} not found.`);
      }
      const record = await this.configs.getBranchConfig(branch.id);
      if (!record) {
        throw new KraConfigError(
          'BRANCH_CONFIG_MISSING',
          `Branch ${branch.id} has no KRA configuration.`,
          'branch',
        );
      }
      return this.validateRecord(record, 'branch', branch.id);
    }
    const record = await this.configs.getCompanyConfig(target.companyId);
    if (!record) {
      throw new KraConfigError(
        'COMPANY_CONFIG_MISSING',
        'No company-level KRA configuration exists.',
        'company',
      );
    }
    return this.validateRecord(record, 'company', null);
  }

  /** Non-throwing view of the company configuration. Reads only the company table. */
  async inspectCompany(companyId: string): Promise<KraConfigInspection> {
    return this.inspectRecord(await this.configs.getCompanyConfig(companyId), 'company', null);
  }

  /**
   * Non-throwing view of many independent branches in a single query, however many there
   * are. Reads only the branch table; the caller decides which branches to ask about.
   */
  async inspectBranches(branchIds: string[]): Promise<Map<string, KraConfigInspection>> {
    const records = branchIds.length !== 0 ? await this.configs.getBranchConfigs(branchIds) : new Map();
    return new Map(
      branchIds.map((id) => [id, this.inspectRecord(records.get(id) ?? null, 'branch', id)]),
    );
  }

  private inspectRecord(
    record: KraConfigRecord | null,
    source: KraConfigSource,
    branchId: string | null,
  ): KraConfigInspection {
    const base = { source, branchId };
    if (!record) {
      const reason =
        source === 'branch'
          ? `Branch ${branchId} acts independently but has no KRA configuration.`
          : 'No company-level KRA configuration exists.';
      return { ...base, mode: null, usable: false, reason };
    }
    const mode = KRA_MODES.includes(record.mode as KraMode) ? (record.mode as KraMode) : null;
    try {
      this.validateRecord(record, source, branchId);
      return { ...base, mode, usable: true, reason: null };
    } catch (error: unknown) {
      if (!(error instanceof KraConfigError)) throw error;
      return { ...base, mode, usable: false, reason: error.message };
    }
  }

  /** Throws KraConfigError if the record cannot be used. Pure: no reads. */
  validateRecord(
    record: KraConfigRecord,
    source: KraConfigSource,
    branchId: string | null,
  ): ResolvedKraConfig {
    const where = source === 'branch' ? `Branch ${branchId}` : 'Company';
    if (!record.isEnabled) {
      throw new KraConfigError(
        'CONFIG_DISABLED',
        `${where} KRA configuration is disabled.`,
        source,
      );
    }
    if (!KRA_MODES.includes(record.mode as KraMode)) {
      throw new KraConfigError(
        'CONFIG_INCOMPLETE',
        `${where} KRA mode "${record.mode}" is not valid.`,
        source,
      );
    }
    const base = { source, branchId, environment: record.environment };

    if (record.mode === 'etims') {
      const apiBaseUrl = record.apiBaseUrl?.trim().replace(/\/+$/, '');
      if (!has(apiBaseUrl)) {
        throw new KraConfigError('CONFIG_INCOMPLETE', `${where} eTIMS API URL is missing.`, source);
      }
      return {
        ...base,
        mode: 'etims',
        apiBaseUrl,
        credentials: readEtimsCredentials(record, where, source),
      };
    }

    return { ...base, mode: 'tims', settings: readTimsSettings(record, where, source) };
  }
}

function readEtimsCredentials(
  record: KraConfigRecord,
  where: string,
  source: KraConfigSource,
): EtimsCredentials {
  let creds: Partial<EtimsCredentials> | null = null;
  try {
    creds = (decryptCredentials(record.credentialsEncrypted));
  } catch {
    throw new KraConfigError(
      'CONFIG_INCOMPLETE',
      `${where} eTIMS credentials could not be decrypted.`,
      source,
    );
  }
  if (!has(creds?.username) || !has(creds.password)) {
    throw new KraConfigError(
      'CONFIG_INCOMPLETE',
      `${where} eTIMS credentials are missing.`,
      source,
    );
  }
  return { username: creds.username, password: creds.password };
}

function readTimsSettings(
  record: KraConfigRecord,
  where: string,
  source: KraConfigSource,
): TimsSettings {
  const { zfpLabServerUrl, connection, cuSerial } = record.settings as Partial<TimsSettings>;
  if (!has(zfpLabServerUrl) || !has(cuSerial) || (connection !== 'tcp' && connection !== 'com')) {
    throw new KraConfigError(
      'CONFIG_INCOMPLETE',
      `${where} TIMS settings (ZFPLabServer URL, connection, CU serial) are incomplete.`,
      source,
    );
  }
  return { zfpLabServerUrl, connection, cuSerial };
}
