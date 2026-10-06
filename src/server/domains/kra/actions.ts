'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { decryptCredentials, encryptCredentials } from '@/server/domains/payments/crypto';
import type { KraConfigRecord } from './resolver';
import { SIGNING_MODULES, type ModuleSigning } from './signing/types';
import { KRA_MODES, type EtimsCredentials, type KraEnvironment, type KraMode } from './types';

const SETTINGS_PATH = '/admin/settings/tax-compliance/kra-tims-etims';

/** Config as shown in the admin UI — never includes the password. */
export interface KraConfigView {
  mode: KraMode;
  isEnabled: boolean;
  environment: KraEnvironment;
  apiBaseUrl: string;
  username: string;
  hasPassword: boolean;
  zfpLabServerUrl: string;
  connection: 'tcp' | 'com';
  cuSerial: string;
  allowEtimsSigning: boolean;
  allowTimsSigning: boolean;
  moduleSigning: ModuleSigning;
}

export interface KraBranchSettingsView {
  id: string;
  code: string;
  name: string;
  actsIndependently: boolean;
  config: KraConfigView | null;
}

export interface KraSettingsView {
  company: KraConfigView | null;
  branches: KraBranchSettingsView[];
}

export interface KraConfigInput {
  mode: KraMode;
  isEnabled: boolean;
  environment: KraEnvironment;
  apiBaseUrl: string;
  /** Blank username/password keeps the stored credentials. */
  username: string;
  password: string;
  zfpLabServerUrl: string;
  connection: 'tcp' | 'com';
  cuSerial: string;
  allowEtimsSigning: boolean;
  allowTimsSigning: boolean;
  /** Company: a missing module is off. Branch: a missing module inherits the company's. */
  moduleSigning: ModuleSigning;
}

function readCredentials(record: KraConfigRecord | null): Partial<EtimsCredentials> | null {
  if (!record) return null;
  try {
    return decryptCredentials<Partial<EtimsCredentials>>(record.credentialsEncrypted);
  } catch {
    return null;
  }
}

function toView(record: KraConfigRecord | null): KraConfigView | null {
  if (!record) return null;
  const creds = readCredentials(record);
  const s = record.settings as Record<string, unknown>;
  return {
    mode: record.mode as KraMode,
    isEnabled: record.isEnabled,
    environment: record.environment,
    apiBaseUrl: record.apiBaseUrl ?? '',
    username: creds?.username ?? '',
    hasPassword: Boolean(creds?.password),
    zfpLabServerUrl: typeof s.zfpLabServerUrl === 'string' ? s.zfpLabServerUrl : '',
    connection: s.connection === 'com' ? 'com' : 'tcp',
    cuSerial: typeof s.cuSerial === 'string' ? s.cuSerial : '',
    allowEtimsSigning: record.allowEtimsSigning,
    allowTimsSigning: record.allowTimsSigning,
    moduleSigning: record.moduleSigning ?? {},
  };
}

export async function getKraSettingsAction(): Promise<KraSettingsView> {
  await requirePermission('taxes:manage');
  const { companySettings, organizations, branches, kraConfigs } = getContainer();
  const company = await companySettings.ensureSeeded();
  await organizations.ensureDefaultOrgAndBranch(
    company.id,
    company.tradingName || company.legalName,
  );

  const [companyConfig, branchRows, branchConfigs] = await Promise.all([
    kraConfigs.getCompanyConfig(company.id),
    branches.listByCompany(company.id),
    kraConfigs.listBranchConfigs(),
  ]);
  const byBranch = new Map(branchConfigs.map((c) => [c.branchId, c]));
  return {
    company: toView(companyConfig),
    branches: branchRows.map((b) => ({
      id: b.id,
      code: b.code,
      name: b.name,
      actsIndependently: b.actsIndependently,
      config: toView(byBranch.get(b.id) ?? null),
    })),
  };
}

/** Validates the input and builds the row to store. Throws a user-readable Error. */
function prepareWrite(input: KraConfigInput, existing: KraConfigRecord | null) {
  if (!KRA_MODES.includes(input.mode)) throw new Error('Choose TIMS or eTIMS.');
  const apiBaseUrl = input.apiBaseUrl.trim().replace(/\/+$/, '');
  const settings = {
    zfpLabServerUrl: input.zfpLabServerUrl.trim(),
    connection: input.connection,
    cuSerial: input.cuSerial.trim(),
  };

  const prior = readCredentials(existing);
  const username = input.username.trim() || prior?.username || '';
  const password = input.password || prior?.password || '';
  const changesCredentials = Boolean(input.username.trim() || input.password);
  if (changesCredentials && (!username || !password)) {
    throw new Error('Both username and password are required when setting credentials.');
  }
  const credentialsEncrypted = changesCredentials
    ? encryptCredentials({ username, password })
    : undefined;

  if (input.isEnabled) {
    if (input.mode === 'etims') {
      try {
        const url = new URL(apiBaseUrl);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
      } catch {
        throw new Error('Enter a valid eTIMS gateway URL (http:// or https://).');
      }
      if (!credentialsEncrypted && !(prior?.username && prior.password))
        throw new Error('eTIMS credentials are required before enabling.');
    } else if (!settings.zfpLabServerUrl || !settings.cuSerial) {
      throw new Error('ZFPLabServer URL and control unit serial are required before enabling.');
    }
  }

  // Keep only known modules with an explicit true/false; an absent key means "not set here".
  const moduleSigning: ModuleSigning = {};
  for (const module of SIGNING_MODULES) {
    const value = input.moduleSigning?.[module];
    if (typeof value === 'boolean') moduleSigning[module] = value;
  }

  return {
    mode: input.mode,
    isEnabled: input.isEnabled,
    allowEtimsSigning: input.allowEtimsSigning === true,
    allowTimsSigning: input.allowTimsSigning === true,
    moduleSigning,
    environment:
      input.environment === 'production' ? ('production' as const) : ('sandbox' as const),
    apiBaseUrl: apiBaseUrl || null,
    settings,
    ...(credentialsEncrypted ? { credentialsEncrypted } : {}),
  };
}

export async function saveCompanyKraConfigAction(input: KraConfigInput): Promise<KraConfigView> {
  await requirePermission('taxes:manage');
  const { companySettings, kraConfigs } = getContainer();
  const company = await companySettings.ensureSeeded();
  const existing = await kraConfigs.getCompanyConfig(company.id);
  const row = await kraConfigs.upsertCompanyConfig(company.id, prepareWrite(input, existing));
  revalidatePath(SETTINGS_PATH, 'layout');
  return toView(row)!;
}

export async function saveBranchKraConfigAction(
  branchId: string,
  input: KraConfigInput,
): Promise<KraConfigView> {
  await requirePermission('taxes:manage');
  const { branches, kraConfigs } = getContainer();
  const branch = await branches.getById(branchId);
  if (!branch) throw new Error('Branch not found.');
  const existing = await kraConfigs.getBranchConfig(branchId);
  const row = await kraConfigs.upsertBranchConfig(branchId, prepareWrite(input, existing));
  revalidatePath(SETTINGS_PATH, 'layout');
  return toView(row)!;
}
