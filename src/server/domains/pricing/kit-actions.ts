'use server';

import { revalidatePath } from 'next/cache';
import { getContainer } from '@/server/di/container';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { requirePermission } from '@/server/domains/access-control/guard';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { ReasonError } from '@/server/kernel/reason-codes/service';
import { PricingConfigError } from './config-service';
import type { KitAllocation } from './domain/kits';
import type { KitView } from './kit-service';
import type { PricingResult } from './actions';

type Reason = { code: string; text?: string };

/** Server action errors are masked in production, so failures come back as data. */
async function run<T>(
  permission: PermissionKey,
  fn: (ctx: { companyId: string; actor: { type: 'user'; id: string } }) => Promise<T>,
): Promise<PricingResult<T>> {
  try {
    const userId = await requirePermission(permission);
    const company = await getContainer().companySettings.ensureSeeded();
    await getContainer().reasonCodes.ensureSystemReasons(company.id);
    return {
      ok: true,
      data: await fn({ companyId: company.id, actor: { type: 'user', id: userId } }),
    };
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError)
      return { ok: false, error: 'You do not have permission to do that.', forbidden: true };
    if (error instanceof PricingConfigError)
      return { ok: false, error: error.message, code: error.code, issues: error.issues };
    if (error instanceof ReasonError) return { ok: false, error: error.message, code: error.code };
    console.error('[kits]', error);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}

const revalidate = () => revalidatePath('/admin/pricing', 'layout');

export async function listKitsAction(): Promise<PricingResult<KitView[]>> {
  return run('pricing:read', ({ companyId }) => getContainer().kitConfig.list(companyId));
}

export async function saveKitAction(
  input: {
    productId: string;
    allocation: KitAllocation;
    components: Array<{ productId: string; quantity: number; weight?: number | null }>;
    isActive?: boolean;
  },
  reason: Reason,
): Promise<PricingResult<KitView>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    const kit = await getContainer().kitConfig.save(companyId, input, actor, reason);
    revalidate();
    return kit;
  });
}

export async function removeKitAction(
  productId: string,
  reason: Reason,
): Promise<PricingResult<null>> {
  return run('pricing:manage', async ({ companyId, actor }) => {
    await getContainer().kitConfig.remove(companyId, productId, actor, reason);
    revalidate();
    return null;
  });
}

/** How a kit price would be split, for trying settings out before saving. */
export async function previewKitAction(input: {
  total: number;
  allocation: KitAllocation;
  components: Array<{ productId: string; quantity: number; weight?: number | null }>;
}): Promise<
  PricingResult<
    Array<{ productId: string; name: string; quantity: number; amount: number; taxRate: number }>
  >
> {
  return run('pricing:read', ({ companyId }) => getContainer().kitConfig.preview(companyId, input));
}
