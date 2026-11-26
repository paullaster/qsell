'use server';

import { getContainer } from '@/server/di/container';
import {
  PRINTED_RECORDS,
  readShow,
  resolveRecordPrint,
  resolveReportPrint,
  showProblem,
  type BrandProfile,
  type BrandShow,
  type PrintedRecord,
} from '@/lib/print-branding';
import { isRecord } from '@/lib/values';
import { reportModules, reportModuleCodes } from '@/server/domains/reports/registry/modules';
import { runSetting } from '@/server/domains/settings/action-runner';
import { SettingsError } from '@/server/domains/settings/errors';
import { toCompanyProfile } from './repository';

/** What the screens that choose a printed heading need: the choices as they stand, and the business's own details to show them with. */
export interface ReportPrintScreen {
  general: BrandShow;
  /** Every module of reports, with its own heading when it has one (null: it uses the general heading). */
  modules: { code: string; label: string; own: BrandShow | null }[];
  profile: BrandProfile;
}

export interface RecordPrintScreen {
  show: BrandShow;
  profile: BrandProfile;
}

const profileOf = (company: Parameters<typeof toCompanyProfile>[0]): BrandProfile => {
  const p = toCompanyProfile(company);
  return {
    tradingName: p.tradingName,
    legalName: p.legalName,
    tagline: p.tagline ?? null,
    streetAddress: p.streetAddress,
    city: p.city,
    countyOrState: p.countyOrState,
    postalCode: p.postalCode,
    country: p.country,
    email: p.email,
    phone: p.phone,
    tel: p.tel ?? null,
    website: p.website ?? null,
    kraPin: p.kraPin,
    logoUrl: p.logoUrl ?? null,
  };
};

const REPORT_PATHS = ['/admin/settings/reports'];

export async function reportPrintScreenAction() {
  return await runSetting('company:manage', ({ company }): Promise<ReportPrintScreen> => {
    const settings = resolveReportPrint(company.uiConfig.reportPrint, reportModuleCodes());
    return Promise.resolve({
      general: settings.general,
      modules: reportModules().map((m) => ({ ...m, own: settings.modules[m.code] ?? null })),
      profile: profileOf(company),
    });
  });
}

/**
 * Saves the heading for all reports (`module` null) or for one module of reports. A module's heading of `null` takes its own
 * choice away, so it follows the general heading again.
 */
export async function saveReportPrintAction(raw: unknown) {
  return await runSetting(
    'company:manage',
    async ({ company }): Promise<ReportPrintScreen> => {
      const sent = isRecord(raw) ? raw : {};
      const codes = reportModuleCodes();
      const forAll = sent.module === null;
      const moduleCode = typeof sent.module === 'string' ? sent.module : null;
      if (!forAll && (moduleCode === null || !codes.includes(moduleCode))) {
        throw new SettingsError('Choose which reports this heading is for.');
      }
      if (sent.show !== null) {
        const problem = showProblem(sent.show);
        if (problem !== null) throw new SettingsError(problem);
      }
      if (forAll && sent.show === null) {
        throw new SettingsError('The heading for all reports needs a choice.');
      }
      const now = resolveReportPrint(company.uiConfig.reportPrint, codes);
      let modules = now.modules;
      let general = now.general;
      if (moduleCode === null) general = readShow(sent.show);
      else if (sent.show === null) {
        modules = Object.fromEntries(Object.entries(modules).filter(([code]) => code !== moduleCode));
      } else modules = { ...modules, [moduleCode]: readShow(sent.show) };
      const row = await getContainer().companySettings.setUiConfigSection('reportPrint', {
        general,
        modules,
      });
      const saved = resolveReportPrint(row.uiConfig.reportPrint, codes);
      return {
        general: saved.general,
        modules: reportModules().map((m) => ({ ...m, own: saved.modules[m.code] ?? null })),
        profile: profileOf(row),
      };
    },
    { paths: REPORT_PATHS },
  );
}

const RECORD_PATHS: Record<PrintedRecord, string[]> = {
  cash_sale: ['/admin/settings/sales/cash-sales', '/admin/cash-sales'],
};

const isRecordName = (value: unknown): value is PrintedRecord =>
  PRINTED_RECORDS.some((r) => r === value);

export async function recordPrintScreenAction(record: unknown) {
  return await runSetting('selling_settings:manage', ({ company }): Promise<RecordPrintScreen> => {
    if (!isRecordName(record)) throw new SettingsError('That printed record cannot be set up here.');
    return Promise.resolve({
      show: resolveRecordPrint(company.uiConfig.recordPrint)[record],
      profile: profileOf(company),
    });
  });
}

export async function saveRecordPrintAction(record: unknown, show: unknown) {
  return await runSetting(
    'selling_settings:manage',
    async ({ company }): Promise<RecordPrintScreen> => {
      if (!isRecordName(record)) throw new SettingsError('That printed record cannot be set up here.');
      const problem = showProblem(show);
      if (problem !== null) throw new SettingsError(problem);
      const now = resolveRecordPrint(company.uiConfig.recordPrint);
      const row = await getContainer().companySettings.setUiConfigSection('recordPrint', {
        ...now,
        [record]: readShow(show),
      });
      return { show: resolveRecordPrint(row.uiConfig.recordPrint)[record], profile: profileOf(row) };
    },
    { paths: isRecordName(record) ? RECORD_PATHS[record] : [] },
  );
}
