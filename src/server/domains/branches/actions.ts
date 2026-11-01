'use server';

import { getContainer } from '@/server/di/container';
import { runSetting, SettingsError } from '@/server/domains/settings/action-runner';
import { isUniqueViolation } from '@/server/domains/settings/errors';
import type { PageInput } from '@/server/domains/settings/paging';
import type { BranchRow } from '@/server/db/drizzle/schema';
import { orElse, trimToNull } from '@/lib/values';
import { readGeoPoint } from '@/lib/geo';

const PATHS = ['/admin/settings/branches', '/admin/settings/payments', '/admin/settings/tax-compliance/kra-tims-etims'];

export interface BranchView {
  id: string;
  code: string;
  name: string;
  actsIndependently: boolean;
  isDefault: boolean;
  isActive: boolean;
  /** Where the branch is on the map, or null when nobody has set it: delivery cannot work out distances from it until then. */
  pin: { latitude: number; longitude: number; label: string | null; setAt: string | null } | null;
}

const toView = (b: BranchRow): BranchView => ({
  id: b.id,
  code: b.code,
  name: b.name,
  actsIndependently: b.actsIndependently,
  isDefault: b.isDefault,
  isActive: b.isActive,
  pin: b.latitude === null || b.longitude === null ? null : { latitude: b.latitude, longitude: b.longitude, label: b.pinLabel, setAt: b.pinSetAt?.toISOString() ?? null },
});

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

/** Where a branch is. A pin the person dropped, typed in, or took from their phone's location; checked here, never trusted from the browser. */
export async function setBranchPinAction(id: string, input: { latitude: unknown; longitude: unknown; label?: string }) {
  return runSetting(
    'branches:manage',
    async ({ companyId, userId }) => {
      const before = await ownBranch(companyId, id);
      const point = readGeoPoint(input.latitude, input.longitude);
      if (!point.ok) throw new SettingsError(point.error);
      const label = trimToNull(input.label)?.slice(0, 120) ?? null;
      const { branches, decisionLog } = getContainer();
      const updated = await branches.update(id, { latitude: point.point.latitude, longitude: point.point.longitude, pinLabel: label, pinSetAt: new Date(), pinSetBy: userId });
      await decisionLog.record({
        companyId,
        subject: { type: 'branch', id },
        action: 'branches.pin_set',
        actor: { type: 'user', id: userId },
        from: before.latitude === null ? 'no pin' : `${String(before.latitude)},${String(before.longitude)}`,
        to: `${String(point.point.latitude)},${String(point.point.longitude)}`,
      });
      return toView(updated);
    },
    { paths: PATHS, friendly },
  );
}

/** Takes the pin off a branch, for example one that moved. Delivery then leaves it out of the nearest-branch choice. */
export async function clearBranchPinAction(id: string) {
  return runSetting(
    'branches:manage',
    async ({ companyId, userId }) => {
      const before = await ownBranch(companyId, id);
      const { branches, decisionLog } = getContainer();
      const updated = await branches.update(id, { latitude: null, longitude: null, pinLabel: null, pinSetAt: null, pinSetBy: null });
      await decisionLog.record({
        companyId,
        subject: { type: 'branch', id },
        action: 'branches.pin_cleared',
        actor: { type: 'user', id: userId },
        from: before.latitude === null ? 'no pin' : `${String(before.latitude)},${String(before.longitude)}`,
        to: 'no pin',
      });
      return toView(updated);
    },
    { paths: PATHS, friendly },
  );
}
