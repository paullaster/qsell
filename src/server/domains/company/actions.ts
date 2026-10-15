'use server';

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getContainer } from '@/server/di/container';
import type { CompanySettingsRow } from '@/server/db/drizzle/schema';
import { runSetting } from '@/server/domains/settings/action-runner';
import { SettingsError } from '@/server/domains/settings/errors';
import { getAdminNav } from '@/config/admin-nav';
import { flattenModuleLabelOptions, resolveCompanyUiConfig, resolveSupportConfig, type CompanySupportConfig, type CompanyUiConfig } from '@/config/company-ui';
import {
  appearancePayload,
  moduleLabelsPayload,
  profileFormFrom,
  profilePayload,
  type AppearanceForm,
  type ProfileForm,
  type ProfileView,
} from '@/lib/company-forms';
import { detectLogoKind, MAX_LOGO_BYTES } from '@/lib/logo-file';
import { toPublicCompany, type PublicCompany } from '@/lib/company-view';

const PAGES = ['/', '/admin', '/admin/company', '/admin/company/profile', '/admin/company/appearance', '/admin/company/modules', '/admin/company/support', '/admin/orders'];

/**
 * What the storefront and the admin shell may know about the company. Bank details are left out:
 * this answers anyone, so it only holds what is already printed on invoices and shown to customers.
 */
export async function getCompanySettingsAction(): Promise<PublicCompany> {
  return toPublicCompany(await getContainer().companySettings.ensureSeeded());
}

/** Resolved UI config with defaults — safe for storefront/admin consumers. */
export async function getCompanyUiConfigAction(): Promise<CompanyUiConfig> {
  const row = await getContainer().companySettings.ensureSeeded();
  return resolveCompanyUiConfig(row.uiConfig);
}

const knownModuleIds = (): string[] => flattenModuleLabelOptions(getAdminNav()).map((m) => m.id);

// ── Reading, for the people who manage the company ───────────────────────

export async function companyProfileAction() {
  return runSetting('company:manage', async (): Promise<ProfileView> => profileFormFrom(await getContainer().companySettings.ensureSeeded()));
}

export async function companyAppearanceAction() {
  return runSetting('company:manage', async (): Promise<AppearanceForm> => {
    const row = await getContainer().companySettings.ensureSeeded();
    return { primaryColor: row.primaryColor, accentColor: row.accentColor, desktopColumns: resolveCompanyUiConfig(row.uiConfig).productGrid.desktopColumns };
  });
}

export async function companyModulesAction() {
  return runSetting('company:manage', async (): Promise<Record<string, string>> => {
    const row = await getContainer().companySettings.ensureSeeded();
    return resolveCompanyUiConfig(row.uiConfig).moduleLabels;
  });
}

export async function companySupportAction() {
  return runSetting('company:manage', async (): Promise<CompanySupportConfig> => {
    const row = await getContainer().companySettings.ensureSeeded();
    return resolveCompanyUiConfig(row.uiConfig).support;
  });
}

// ── Saving ───────────────────────────────────────────────────────────────

/** Saves the profile. The form is checked again here: what the browser sent is never trusted. */
export async function saveCompanyProfileAction(form: ProfileForm) {
  return runSetting(
    'company:manage',
    async (): Promise<ProfileView> => {
      const checked = profilePayload(form);
      if (!checked.ok) throw new SettingsError(checked.error);
      return profileFormFrom(await getContainer().companySettings.update(checked.payload));
    },
    { paths: PAGES },
  );
}

/** Saves the colours and the product density. Only these two parts of the stored look change. */
export async function saveCompanyAppearanceAction(form: AppearanceForm) {
  return runSetting(
    'company:manage',
    async (): Promise<AppearanceForm> => {
      const checked = appearancePayload(form);
      if (!checked.ok) throw new SettingsError(checked.error);
      const { companySettings } = getContainer();
      await companySettings.update({ primaryColor: checked.payload.primaryColor, accentColor: checked.payload.accentColor });
      await companySettings.setUiConfigSection('productGrid', { desktopColumns: checked.payload.desktopColumns });
      return checked.payload;
    },
    { paths: PAGES },
  );
}

/** Saves the module names: only the modules that exist, only the one part of the stored look. */
export async function saveCompanyModulesAction(labels: Record<string, string>) {
  return runSetting(
    'company:manage',
    async (): Promise<Record<string, string>> => {
      const checked = moduleLabelsPayload(labels, knownModuleIds());
      if (!checked.ok) throw new SettingsError(checked.error);
      await getContainer().companySettings.setUiConfigSection('moduleLabels', checked.payload);
      return checked.payload;
    },
    { paths: PAGES },
  );
}

/** Replaces the storefront help & support content; rows without a value are dropped by the sanitiser. */
export async function saveCompanySupportAction(support: Partial<CompanySupportConfig>) {
  return runSetting(
    'company:manage',
    async (): Promise<CompanySupportConfig> => {
      const clean = resolveSupportConfig(support);
      const updated = await getContainer().companySettings.setUiConfigSection('support', clean);
      return resolveCompanyUiConfig(updated.uiConfig).support;
    },
    { paths: PAGES },
  );
}

/**
 * Stores a new logo. What the file is comes from its own bytes, not from its name or the type the
 * browser reported; a picture that could run anything is refused.
 */
export async function uploadCompanyLogoAction(formData: FormData) {
  return runSetting(
    'company:manage',
    async (): Promise<{ logoUrl: string }> => {
      const file = formData.get('logo');
      if (!(file instanceof File) || file.size === 0) throw new SettingsError('Choose a logo image to upload.');
      if (file.size > MAX_LOGO_BYTES) throw new SettingsError('The logo must be 2 MB or smaller.');
      const buffer = Buffer.from(await file.arrayBuffer());
      const kind = detectLogoKind(buffer);
      if (kind === null) throw new SettingsError('The logo must be a PNG, JPEG, WebP or plain SVG picture.');
      const dir = path.join(process.cwd(), 'public', 'uploads', 'company');
      await mkdir(dir, { recursive: true });
      const filename = `logo-${String(Date.now())}-${randomUUID()}.${kind}`;
      await writeFile(path.join(dir, filename), buffer);
      const logoUrl = `/api/company/logo/${filename}`;
      const updated: CompanySettingsRow = await getContainer().companySettings.update({ logoUrl });
      return { logoUrl: updated.logoUrl ?? logoUrl };
    },
    { paths: PAGES },
  );
}
