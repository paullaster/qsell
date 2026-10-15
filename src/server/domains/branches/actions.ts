'use server';

import { getContainer } from '@/server/di/container';
import { runSetting, SettingsError } from '@/server/domains/settings/action-runner';
import { isUniqueViolation } from '@/server/domains/settings/errors';
import type { PageInput } from '@/server/domains/settings/paging';
import type { BranchRow } from '@/server/db/drizzle/schema';
import { orElse } from '@/lib/values';

const PATHS = ['/admin/settings/branches', '/admin/settings/payments', '/admin/settings/tax-compliance/kra-tims-etims'];

export interface BranchView {
  id: string;
  code: string;
  name: string;
  actsIndependently: boolean;
  isDefault: boolean;
  isActive: boolean;
}

const toView = (b: BranchRow): BranchView => ({ id: b.id, code: b.code, name: b.name, actsIndependently: b.actsIndependently, isDefault: b.isDefault, isActive: b.isActive });

const friendly = (error: unknown): string | null => (isUniqueViolation(error) ? 'A branch with that code already exists.' : null);

/** The company always has a first branch; this makes sure of it before anything is listed. */
async function ensureFirstBranch(companyId: string): Promise<void> {
  const { companySettings, organizations } = getContainer();
  const company = await companySettings.ensureSeeded();
  await organizations.ensureDefaultOrgAndBranch(companyId, orElse(company.tradingName, company.legalName));
}

/** One page of the branches in name order. */
export async function branchesPageAction(input: PageInput) {
  return runSetting('branches:read', async ({ companyId }) => {
    await ensureFirstBranch(companyId);
    const page = await getContainer().branches.pageByCompany(companyId, input);
    return { rows: page.rows.map(toView), nextCursor: page.nextCursor };
  });
}

/** The branch, only when it is this company's. */
async function ownBranch(companyId: string, id: string): Promise<BranchRow> {
  const row = await getContainer().branches.getById(id);
  if (row?.companyId !== companyId) throw new SettingsError('That branch does not exist.', 'NOT_FOUND');
  return row;
}

export async function createBranchAction(input: { code: string; name: string; actsIndependently?: boolean }) {
  return runSetting(
    'branches:manage',
    async ({ companyId }) => {
      const code = input.code.trim().toUpperCase();
      const name = input.name.trim();
      if (code === '' || name === '') throw new SettingsError('A branch needs a code and a name.');
      const created = await getContainer().branches.create({ companyId, code, name, actsIndependently: input.actsIndependently === true, isDefault: false, isActive: true });
      return toView(created);
    },
    { paths: PATHS, friendly },
  );
}

export async function updateBranchAction(id: string, patch: { actsIndependently?: boolean; isDefault?: boolean }) {
  return runSetting(
    'branches:manage',
    async ({ companyId }) => {
      await ownBranch(companyId, id);
      const updated = await getContainer().branches.update(id, {
        ...(patch.actsIndependently === undefined ? {} : { actsIndependently: patch.actsIndependently }),
        ...(patch.isDefault === undefined ? {} : { isDefault: patch.isDefault }),
      });
      return toView(updated);
    },
    { paths: PATHS, friendly },
  );
}
