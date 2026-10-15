import { and, eq, asc } from 'drizzle-orm';
import { afterCursor, matching, pageOf, PAGE_SIZE, searchText, type PageInput } from '@/server/domains/settings/paging';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  organizations,
  branches,
  companySettings,
  type BranchRow,
  type BranchInsert,
  type OrganizationRow,
} from '@/server/db/drizzle/schema';
import { ensureManualProvider } from '@/server/domains/payments/manual-provider';

export class BranchRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByCompany(companyId: string): Promise<BranchRow[]> {
    return await this.db
      .select()
      .from(branches)
      .where(eq(branches.companyId, companyId))
      .orderBy(asc(branches.name));
  }

  /** One page of the company's branches in name order, optionally narrowed by text. */
  async pageByCompany(companyId: string, input: PageInput) {
    const rows = await this.db
      .select()
      .from(branches)
      .where(and(eq(branches.companyId, companyId), matching(searchText(input), [branches.name, branches.code]), afterCursor(input.cursor, branches.name, branches.id)))
      .orderBy(asc(branches.name), asc(branches.id))
      .limit(PAGE_SIZE + 1);
    return pageOf(rows, PAGE_SIZE, (r) => ({ k: r.name, id: r.id }));
  }

  /** All active branches, unordered — used by the users & access module. */
  async listActive(): Promise<BranchRow[]> {
    return await this.db
      .select()
      .from(branches)
      .where(eq(branches.isActive, true))
      .orderBy(asc(branches.name));
  }

  async getById(id: string): Promise<BranchRow | null> {
    const rows = await this.db.select().from(branches).where(eq(branches.id, id)).limit(1);
    return rows.at(0) ?? null;
  }

  async getByCode(companyId: string, code: string): Promise<BranchRow | null> {
    const rows = await this.db
      .select()
      .from(branches)
      .where(and(eq(branches.companyId, companyId), eq(branches.code, code)))
      .limit(1);
    return rows.at(0) ?? null;
  }

  async getDefault(companyId: string): Promise<BranchRow | null> {
    const defaults = await this.db
      .select()
      .from(branches)
      .where(and(eq(branches.companyId, companyId), eq(branches.isDefault, true)))
      .limit(1);
    const defaultRow = defaults.at(0);
    if (defaultRow) return defaultRow;
    const any = await this.db
      .select()
      .from(branches)
      .where(eq(branches.companyId, companyId))
      .limit(1);
    return any.at(0) ?? null;
  }

  async create(
    data: Omit<BranchInsert, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<BranchRow> {
    if (data.isDefault === true) {
      await this.clearDefault(data.companyId);
    }
    const rows = await this.db.insert(branches).values(data).returning();
    const row = rows.at(0) ?? null;
    if (!row) throw new Error(`Failed to create branch ${data.code}`);
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<BranchInsert, 'id' | 'companyId' | 'createdAt'>>,
  ): Promise<BranchRow> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Branch ${id} not found`);
    if (patch.isDefault === true) {
      await this.clearDefault(existing.companyId);
    }
    const rows = await this.db
      .update(branches)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(branches.id, id))
      .returning();
    const row = rows.at(0) ?? null;
    if (!row) throw new Error(`Failed to update branch ${id}`);
    return row;
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
    const company = companyRows.at(0) ?? null;
    if (!company) throw new Error('Company not found');

    let organization: OrganizationRow | null = null;
    if (company.organizationId !== null) {
      const orgs = await this.db
        .select()
        .from(organizations)
        .where(eq(organizations.id, company.organizationId))
        .limit(1);
      organization = orgs.at(0) ?? null;
    }

    if (!organization) {
      const trimmed = companyName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48);
      const slug = trimmed === '' ? 'default' : trimmed;
      const orgRows = await this.db
        .insert(organizations)
        .values({ name: companyName, slug: `${slug}-${Date.now().toString(36)}` })
        .returning();
      const createdOrg = orgRows.at(0) ?? null;
      if (!createdOrg) throw new Error('Failed to create organization');
      organization = createdOrg;
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

      // Providers belong to the company, not the branch: only the built-in Manual one is made here.
      await ensureManualProvider(this.db, company.id);
    }

    return { organization, branch };
  }
}
