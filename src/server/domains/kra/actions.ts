'use server';

import { runSetting } from '@/server/domains/settings/action-runner';
import { SettingsError } from '@/server/domains/settings/errors';
import type { PageInput } from '@/server/domains/settings/paging';
import { getContainer } from '@/server/di/container';
import { decryptCredentials, encryptCredentials } from '@/server/domains/payments/crypto';
import type { KraConfigRecord } from './resolver';
import { SIGNING_MODULES, type ModuleSigning } from './signing/types';
import { KRA_MODES, type EtimsCredentials, type KraEnvironment, type KraMode } from './types';

import { emptyToNull, firstFilled, has, orElse, required } from '@/lib/values';

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
    return (decryptCredentials(record.credentialsEncrypted));
  } catch {
    return null;
  }
}

function toView(record: KraConfigRecord | null): KraConfigView | null {
  if (!record) return null;
  const creds = readCredentials(record);
  const s = record.settings;
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
    moduleSigning: record.moduleSigning,
  };
}

/** The company's KRA configuration (never the password), or none yet. */
export async function kraCompanyAction() {
  return runSetting('taxes:manage', async ({ companyId }) => {
    const { organizations, companySettings, kraConfigs } = getContainer();
    const company = await companySettings.ensureSeeded();
    await organizations.ensureDefaultOrgAndBranch(companyId, orElse(company.tradingName, company.legalName));
    return { company: toView(await kraConfigs.getCompanyConfig(companyId)) };
  });
}

/** One page of branches in name order, each with its own KRA configuration where it has one. */
export async function kraBranchesPageAction(input: PageInput) {
  return runSetting('taxes:manage', async ({ companyId }) => {
    const { branches, kraConfigs, companySettings, organizations } = getContainer();
    const company = await companySettings.ensureSeeded();
    await organizations.ensureDefaultOrgAndBranch(companyId, orElse(company.tradingName, company.legalName));
    const page = await branches.pageByCompany(companyId, input);
    const configs = await kraConfigs.getBranchConfigs(page.rows.map((b) => b.id));
    const rows: KraBranchSettingsView[] = page.rows.map((b) => ({ id: b.id, code: b.code, name: b.name, actsIndependently: b.actsIndependently, config: toView(configs.get(b.id) ?? null) }));
    return { rows, nextCursor: page.nextCursor };
  });
}

/** Validates the input and builds the row to store. Throws a user-readable Error. */
function prepareWrite(input: KraConfigInput, existing: KraConfigRecord | null) {
  if (!KRA_MODES.includes(input.mode)) throw new SettingsError('Choose TIMS or eTIMS.');
  const apiBaseUrl = input.apiBaseUrl.trim().replace(/\/+$/, '');
  const settings = {
    zfpLabServerUrl: input.zfpLabServerUrl.trim(),
    connection: input.connection,
    cuSerial: input.cuSerial.trim(),
  };

  const prior = readCredentials(existing);
  const username = (firstFilled(input.username.trim(), prior?.username) ?? '');
  const password = (firstFilled(input.password, prior?.password) ?? '');
  const changesCredentials = Boolean(has(input.username.trim()) || input.password);
  if (changesCredentials && (!has(username) || !has(password))) {
    throw new SettingsError('Both username and password are required when setting credentials.');
  }
  const credentialsEncrypted = changesCredentials
    ? encryptCredentials({ username, password })
    : undefined;

  if (input.isEnabled) {
    if (input.mode === 'etims') {
      try {
        const url = new URL(apiBaseUrl);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('not a web address');
      } catch {
        throw new SettingsError('Enter a valid eTIMS gateway URL (http:// or https://).');
      }
      if (!credentialsEncrypted && !(has(prior?.username) && has(prior.password)))
        throw new SettingsError('eTIMS credentials are required before enabling.');
    } else if (!has(settings.zfpLabServerUrl) || !has(settings.cuSerial)) {
      throw new SettingsError('ZFPLabServer URL and control unit serial are required before enabling.');
    }
  }

  // Keep only known modules with an explicit true/false; an absent key means "not set here".
  const moduleSigning: ModuleSigning = {};
  for (const signingModule of SIGNING_MODULES) {
    const value = input.moduleSigning[signingModule];
    if (typeof value === 'boolean') moduleSigning[signingModule] = value;
  }

  return {
    mode: input.mode,
    isEnabled: input.isEnabled,
    allowEtimsSigning: input.allowEtimsSigning,
    allowTimsSigning: input.allowTimsSigning,
    moduleSigning,
    environment:
      input.environment === 'production' ? ('production' as const) : ('sandbox' as const),
    apiBaseUrl: emptyToNull(apiBaseUrl),
    settings,
    ...(credentialsEncrypted ? { credentialsEncrypted } : {}),
  };
}

export async function saveCompanyKraConfigAction(input: KraConfigInput) {
  return runSetting(
    'taxes:manage',
    async ({ companyId }) => {
      const { kraConfigs } = getContainer();
      const existing = await kraConfigs.getCompanyConfig(companyId);
      const row = await kraConfigs.upsertCompanyConfig(companyId, prepareWrite(input, existing));
      return required(toView(row), 'the saved KRA configuration');
    },
    { paths: [SETTINGS_PATH] },
  );
}

export async function saveBranchKraConfigAction(branchId: string, input: KraConfigInput) {
  return runSetting(
    'taxes:manage',
    async ({ companyId }) => {
      const { branches, kraConfigs } = getContainer();
      const branch = await branches.getById(branchId);
      if (branch?.companyId !== companyId) throw new SettingsError('That branch does not exist.', 'NOT_FOUND');
      const existing = await kraConfigs.getBranchConfig(branchId);
      const row = await kraConfigs.upsertBranchConfig(branchId, prepareWrite(input, existing));
      return required(toView(row), 'the saved KRA configuration');
    },
    { paths: [SETTINGS_PATH] },
  );
}
