import { desc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  companySettings,
  type CompanySettingsInsert,
  type CompanySettingsRow,
} from '@/server/db/drizzle/schema';
import type { CompanyProfile } from '@/server/ports/communications';

/** Minimal company row so the app can boot; replace via Company settings. Not demo brand data. */
const DEFAULT_COMPANY: Omit<CompanySettingsInsert, 'id' | 'createdAt' | 'updatedAt'> = {
  legalName: 'Company',
  tradingName: 'Company',
  email: 'admin@localhost',
  phone: '',
  tel: null,
  website: null,
  streetAddress: '',
  city: '',
  countyOrState: '',
  postalCode: '',
  country: '',
  locationLabel: null,
  tagline: null,
  kraPin: '',
  vatNumber: null,
  registrationNumber: null,
  bankName: null,
  bankAccountName: null,
  bankAccountNumber: null,
  bankBranch: null,
  invoiceFooterNote: null,
  invoicePrefix: 'INV',
  logoUrl: null,
  primaryColor: '#111827',
  accentColor: '#4F46E5',
  publicBaseUrl: null,
  uiConfig: {},
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

function dbErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return 'Unknown database error';
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) {
    return `${err.message} (${cause.message})`;
  }
  if (typeof cause === 'string' && cause.trim()) {
    return `${err.message} (${cause})`;
  }
  return err.message;
}

export class CompanySettingsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async ensureSeeded(): Promise<CompanySettingsRow> {
    try {
      const existing = await this.getActive();
      if (existing) return existing;

      const [created] = await this.db.insert(companySettings).values(DEFAULT_COMPANY).returning();
      if (!created) {
        throw new Error('Failed to seed company settings');
      }
      return created;
    } catch (err) {
      throw new Error(
        `Company settings unavailable. If you recently changed the schema, run \`npm run db:push\`. ${dbErrorMessage(err)}`,
        { cause: err },
      );
    }
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

  /**
   * Atomically replace one top-level key of `ui_config` without touching the others,
   * so concurrent edits to different config sections cannot clobber each other.
   */
  async setUiConfigSection(key: string, value: unknown): Promise<CompanySettingsRow> {
    const current = await this.ensureSeeded();
    const patch = JSON.stringify({ [key]: value });
    const [updated] = await this.db
      .update(companySettings)
      .set({
        uiConfig: sql`coalesce(${companySettings.uiConfig}, '{}'::jsonb) || ${patch}::jsonb`,
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
