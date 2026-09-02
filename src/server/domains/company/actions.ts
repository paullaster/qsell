'use server';

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { revalidatePath } from 'next/cache';
import { getContainer } from '@/server/di/container';
import type { CompanySettingsRow } from '@/server/db/drizzle/schema';

function revalidateCompanySurfaces() {
  revalidatePath('/');
  revalidatePath('/admin');
  revalidatePath('/admin/company');
  revalidatePath('/admin/orders');
}

export async function getCompanySettingsAction(): Promise<CompanySettingsRow> {
  const { companySettings } = getContainer();
  return companySettings.ensureSeeded();
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
  }>,
): Promise<CompanySettingsRow> {
  const { companySettings } = getContainer();
  const updated = await companySettings.update(updates);
  revalidateCompanySurfaces();
  return updated;
}

const ALLOWED_LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export async function uploadCompanyLogoAction(formData: FormData): Promise<CompanySettingsRow> {
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
  const filename = `logo-${Date.now()}.${ext}`;
  const absolutePath = path.join(uploadDir, filename);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(absolutePath, buffer);

  const logoUrl = `/uploads/company/${filename}`;
  const { companySettings } = getContainer();
  const updated = await companySettings.update({ logoUrl });
  revalidateCompanySurfaces();
  return updated;
}
