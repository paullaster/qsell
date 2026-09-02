import { desc, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  companySettings,
  type CompanySettingsInsert,
  type CompanySettingsRow,
} from '@/server/db/drizzle/schema';
import type { CompanyProfile } from '@/server/ports/communications';

const DEFAULT_COMPANY: Omit<CompanySettingsInsert, 'id' | 'createdAt' | 'updatedAt'> = {
  legalName: 'OmniCommerce Technologies Limited',
  tradingName: 'OmniCommerce',
  email: 'billing@omnicommerce.ke',
  phone: '+254712345678',
  tel: '+25420 3890000',
  website: 'https://omnicommerce.ke',
  streetAddress: 'Delta Corner, Riverside Drive',
  city: 'Nairobi',
  countyOrState: 'Nairobi County',
  postalCode: '00100',
  country: 'Kenya',
  locationLabel: 'Westlands Business District',
  tagline: 'Hardware & Electronics',
  kraPin: 'P051892011Z',
  vatNumber: 'VAT-OC-2024-001',
  registrationNumber: 'PVT-OC-2024-KE',
  bankName: 'Equity Bank Kenya',
  bankAccountName: 'OmniCommerce Technologies Limited',
  bankAccountNumber: '0123456789012',
  bankBranch: 'Westlands Branch',
  invoiceFooterNote:
    'Thank you for your business. This tax invoice is issued under the Kenya Revenue Authority PIN shown above. Goods once sold are subject to our returns policy.',
  invoicePrefix: 'INV',
  logoUrl: null,
  primaryColor: '#111827',
  accentColor: '#4F46E5',
  isActive: true,
};

export function toCompanyProfile(row: CompanySettingsRow): CompanyProfile {
  return {
    legalName: row.legalName,
    tradingName: row.tradingName,
    email: row.email,
    phone: row.phone,
    tel: row.tel,
    website: row.website,
    streetAddress: row.streetAddress,
    city: row.city,
    countyOrState: row.countyOrState,
    postalCode: row.postalCode,
    country: row.country,
    locationLabel: row.locationLabel,
    tagline: row.tagline,
    kraPin: row.kraPin,
    vatNumber: row.vatNumber,
    registrationNumber: row.registrationNumber,
    bankName: row.bankName,
    bankAccountName: row.bankAccountName,
    bankAccountNumber: row.bankAccountNumber,
    bankBranch: row.bankBranch,
    invoiceFooterNote: row.invoiceFooterNote,
    invoicePrefix: row.invoicePrefix,
    logoUrl: row.logoUrl,
    primaryColor: row.primaryColor,
    accentColor: row.accentColor,
  };
}

export class CompanySettingsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async ensureSeeded(): Promise<CompanySettingsRow> {
    const existing = await this.getActive();
    if (existing) return existing;

    const [created] = await this.db.insert(companySettings).values(DEFAULT_COMPANY).returning();
    if (!created) {
      throw new Error('Failed to seed company settings');
    }
    return created;
  }

  async getActive(): Promise<CompanySettingsRow | null> {
    const rows = await this.db
      .select()
      .from(companySettings)
      .where(eq(companySettings.isActive, true))
      .orderBy(desc(companySettings.updatedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async getProfile(): Promise<CompanyProfile> {
    const row = await this.ensureSeeded();
    return toCompanyProfile(row);
  }

  async update(
    updates: Partial<Omit<CompanySettingsInsert, 'id' | 'createdAt'>>,
  ): Promise<CompanySettingsRow> {
    const current = await this.ensureSeeded();
    const [updated] = await this.db
      .update(companySettings)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(companySettings.id, current.id))
      .returning();
    if (!updated) {
      throw new Error('Failed to update company settings');
    }
    return updated;
  }
}
