'use server';

import { requirePermission } from '@/server/domains/access-control/guard';

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getContainer } from '@/server/di/container';
import type { CompanySettingsRow } from '@/server/db/drizzle/schema';
import {
  resolveCompanyUiConfig,
  resolveSupportConfig,
  toCompanyUiConfigRaw,
  type CompanySupportConfig,
  type CompanyUiConfig,
  type CompanyUiConfigRaw,
} from '@/config/company-ui';

function revalidateCompanySurfaces() {
  revalidatePath('/');
  revalidatePath('/admin');
  revalidatePath('/admin/company');
  revalidatePath('/admin/company/profile');
  revalidatePath('/admin/company/appearance');
  revalidatePath('/admin/company/modules');
  revalidatePath('/admin/company/support');
  revalidatePath('/admin/orders');
}

export async function getCompanySettingsAction(): Promise<CompanySettingsRow> {
  const { companySettings } = getContainer();
  return companySettings.ensureSeeded();
}

/** Resolved UI config with defaults — safe for storefront/admin consumers. */
export async function getCompanyUiConfigAction(): Promise<CompanyUiConfig> {
  const row = await getCompanySettingsAction();
  return resolveCompanyUiConfig(row.uiConfig);
}

export async function updateCompanySettingsAction(
  updates: Partial<{
    legalName: string;
    tradingName: string;
    email: string;
    phone: string;
    tel: string | null;
    website: string | null;
    streetAddress: string;
    city: string;
    countyOrState: string;
    postalCode: string;
    country: string;
    locationLabel: string | null;
    tagline: string | null;
    kraPin: string;
    vatNumber: string | null;
    registrationNumber: string | null;
    bankName: string | null;
    bankAccountName: string | null;
    bankAccountNumber: string | null;
    bankBranch: string | null;
    invoiceFooterNote: string | null;
    invoicePrefix: string;
    logoUrl: string | null;
    primaryColor: string;
    accentColor: string;
    uiConfig: CompanyUiConfigRaw;
  }>,
): Promise<CompanySettingsRow> {
  await requirePermission('company:manage');
  const { companySettings } = getContainer();
  const payload = { ...updates };
  if (updates.uiConfig !== undefined) {
    // Persist only the sanitized/resolved shape so bad client data cannot accumulate.
    // Support content is owned by updateCompanySupportAction: keep what is stored so a stale
    // Appearance/Modules form can never overwrite it.
    const current = await companySettings.ensureSeeded();
    payload.uiConfig = {
      ...toCompanyUiConfigRaw(resolveCompanyUiConfig(updates.uiConfig)),
      support: resolveCompanyUiConfig(current.uiConfig).support,
    };
  }
  const updated = await companySettings.update(payload);
  revalidateCompanySurfaces();
  return updated;
}

/** Replace the storefront help & support content (name, channels, guarantees, FAQs). */
export async function updateCompanySupportAction(
  support: Partial<CompanySupportConfig>,
): Promise<CompanySettingsRow> {
  await requirePermission('company:manage');
  const { companySettings } = getContainer();
  const updated = await companySettings.setUiConfigSection(
    'support',
    resolveSupportConfig(support),
  );
  revalidateCompanySurfaces();
  return updated;
}

const ALLOWED_LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export async function uploadCompanyLogoAction(formData: FormData): Promise<CompanySettingsRow> {
  await requirePermission('company:manage');
  const file = formData.get('logo');
  if (!(file instanceof File) || file.size === 0) {
    throw new Error('Please choose a logo image to upload');
  }
  if (!ALLOWED_LOGO_TYPES.has(file.type)) {
    throw new Error('Logo must be PNG, JPEG, WebP, or SVG');
  }
  if (file.size > MAX_LOGO_BYTES) {
    throw new Error('Logo must be 2MB or smaller');
  }

  const ext =
    file.type === 'image/png'
      ? 'png'
      : file.type === 'image/webp'
        ? 'webp'
        : file.type === 'image/svg+xml'
          ? 'svg'
          : 'jpg';

  const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'company');
  await mkdir(uploadDir, { recursive: true });
  const filename = `logo-${Date.now()}-${randomUUID()}.${ext}`;
  const absolutePath = path.join(uploadDir, filename);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(absolutePath, buffer);

  const logoUrl = `/api/company/logo/${filename}`;
  const { companySettings } = getContainer();
  const updated = await companySettings.update({ logoUrl });
  revalidateCompanySurfaces();
  return updated;
}
