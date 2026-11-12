'use server';

import { getContainer } from '@/server/di/container';
import { runSetting } from '@/server/domains/settings/action-runner';
import { ReasonError } from '@/server/kernel/reason-codes/service';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { canPermission } from '@/server/domains/access-control/guard';
import { PricingConfigError } from './config-service';
import { parsePackageInput } from './domain/package-input';
import { SettingsError } from '@/server/domains/settings/errors';

const PATHS = ['/admin/pricing/packages'];
const friendly = (error: unknown): string | null => (error instanceof PricingConfigError || error instanceof ReasonError ? error.message : null);
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const reasonOf = (value: unknown): { code: string; text?: string } => {
  const r = obj(value);
  const code = typeof r.code === 'string' ? r.code : '';
  return typeof r.text === 'string' ? { code, text: r.text } : { code };
};

/** A read leaves the page cache alone (it runs while the page renders); a change refreshes the screen. */
async function run<T>(permission: PermissionKey, fn: (ctx: { companyId: string; userId: string }) => Promise<T>, changes = false) {
  return await runSetting(
    permission,
    async (ctx) => {
      await getContainer().reasonCodes.ensureSystemReasons(ctx.companyId);
      return await fn({ companyId: ctx.companyId, userId: ctx.userId });
    },
    { ...(changes ? { paths: PATHS } : {}), friendly },
  );
}

/** The packages and whether this person may change them, for the screen. */
export async function packagesScreenAction() {
  return await run('pricing:read', async ({ companyId }) => ({
    packages: await getContainer().packageConfig.list(companyId),
    canManage: await canPermission('pricing:manage'),
  }));
}

export async function savePackageAction(raw: unknown, reason: unknown) {
  return await run('pricing:manage', async ({ companyId, userId }) => {
    const parsed = parsePackageInput(raw);
    if (!parsed.ok) throw new SettingsError(parsed.error, 'BAD_INPUT');
    return await getContainer().packageConfig.save(companyId, parsed.input, { type: 'user', id: userId }, reasonOf(reason));
  }, true);
}

export async function removePackageAction(productId: unknown, reason: unknown) {
  return await run('pricing:manage', async ({ companyId, userId }) => {
    if (typeof productId !== 'string' || productId === '') throw new SettingsError('Choose the package to remove.', 'BAD_INPUT');
    await getContainer().packageConfig.remove(companyId, productId, { type: 'user', id: userId }, reasonOf(reason));
    return null;
  }, true);
}
