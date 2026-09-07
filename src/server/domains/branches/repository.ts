import { and, eq, asc } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  organizations,
  branches,
  companySettings,
  type BranchRow,
  type BranchInsert,
  type OrganizationRow,
} from '@/server/db/drizzle/schema';
import { PAYMENT_PROVIDER_META, type PaymentProviderCode } from '@/server/domains/payments/types';
import { PaymentConfigRepository } from '@/server/domains/payments/repository';

export class BranchRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByCompany(companyId: string): Promise<BranchRow[]> {
    return this.db
      .select()
      .from(branches)
      .where(eq(branches.companyId, companyId))
      .orderBy(asc(branches.name));
  }

  async getById(id: string): Promise<BranchRow | null> {
    const rows = await this.db.select().from(branches).where(eq(branches.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async getDefault(companyId: string): Promise<BranchRow | null> {
    const defaults = await this.db
      .select()
      .from(branches)
      .where(and(eq(branches.companyId, companyId), eq(branches.isDefault, true)))
      .limit(1);
    if (defaults[0]) return defaults[0];
    const any = await this.db
      .select()
      .from(branches)
      .where(eq(branches.companyId, companyId))
      .limit(1);
    return any[0] ?? null;
  }

  async create(
    data: Omit<BranchInsert, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<BranchRow> {
    if (data.isDefault) {
      await this.clearDefault(data.companyId);
    }
    const [row] = await this.db.insert(branches).values(data).returning();
    return row!;
  }

  async update(
    id: string,
    patch: Partial<Omit<BranchInsert, 'id' | 'companyId' | 'createdAt'>>,
  ): Promise<BranchRow> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Branch ${id} not found`);
    if (patch.isDefault) {
      await this.clearDefault(existing.companyId);
    }
    const [row] = await this.db
      .update(branches)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(branches.id, id))
      .returning();
    return row!;
  }

  private async clearDefault(companyId: string) {
    await this.db
      .update(branches)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(eq(branches.companyId, companyId), eq(branches.isDefault, true)));
  }
}

export class OrganizationRepository {
  constructor(private readonly db: DrizzleDb) {}

  async ensureDefaultOrgAndBranch(companyId: string, companyName: string): Promise<{
    organization: OrganizationRow;
    branch: BranchRow;
  }> {
    const companyRows = await this.db
      .select()
      .from(companySettings)
      .where(eq(companySettings.id, companyId))
      .limit(1);
    const company = companyRows[0];
    if (!company) throw new Error('Company not found');

    let organization: OrganizationRow | null = null;
    if (company.organizationId) {
      const orgs = await this.db
        .select()
        .from(organizations)
        .where(eq(organizations.id, company.organizationId))
        .limit(1);
      organization = orgs[0] ?? null;
    }

    if (!organization) {
      const slug = companyName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48) || 'default';
      const [createdOrg] = await this.db
        .insert(organizations)
        .values({ name: companyName, slug: `${slug}-${Date.now().toString(36)}` })
        .returning();
      organization = createdOrg!;
      await this.db
        .update(companySettings)
        .set({ organizationId: organization.id, updatedAt: new Date() })
        .where(eq(companySettings.id, companyId));
    }

    const branchRepo = new BranchRepository(this.db);
    let branch = await branchRepo.getDefault(companyId);
    if (!branch) {
      branch = await branchRepo.create({
        companyId,
        code: 'HQ',
        name: 'Head Office',
        email: company.email,
        phone: company.phone,
        streetAddress: company.streetAddress,
        city: company.city,
        countyOrState: company.countyOrState,
        postalCode: company.postalCode,
        country: company.country,
        kraPin: company.kraPin,
        vatNumber: company.vatNumber,
        registrationNumber: company.registrationNumber,
        bankName: company.bankName,
        bankAccountName: company.bankAccountName,
        bankAccountNumber: company.bankAccountNumber,
        bankBranch: company.bankBranch,
        actsIndependently: false,
        publicBaseUrl: company.publicBaseUrl,
        isDefault: true,
        isActive: true,
      });

      // Seed empty provider config rows (disabled) so admin UI has something to edit.
      const configRepo = new PaymentConfigRepository(this.db);
      for (const code of Object.keys(PAYMENT_PROVIDER_META) as PaymentProviderCode[]) {
        const meta = PAYMENT_PROVIDER_META[code];
        await configRepo.upsert({
          branchId: branch.id,
          providerCode: code,
          displayName: meta.label,
          isEnabled: false,
          environment: 'staging',
          apiBaseUrl: meta.defaultStagingBaseUrl,
          credentialsEncrypted: null,
          settings: {},
          replaceCredentials: true,
        });
      }
    }

    return { organization, branch };
  }
}
