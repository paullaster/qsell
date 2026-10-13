import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { canPermission, requirePermission } from '@/server/domains/access-control/guard';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { getContainer } from '@/server/di/container';
import { ReasonError } from '@/server/kernel/reason-codes/service';
import { AmountErrorGuard } from './action-support';
import { PostingError, type PostingPermissions } from './engine';
import { FinanceError, type FinanceContext } from './errors';

export type FinanceResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; issues?: { code?: string; message: string; line?: number }[]; forbidden?: true };

/**
 * Every finance action goes through here: one explicit permission per action, the actor and the
 * origin (which screen, from where) set on the server, and failures returned as data because
 * server-action errors are masked in production.
 */
export async function run<T>(
  permission: PermissionKey,
  origin: { surface: string; action: string },
  fn: (ctx: FinanceContext, userId: string) => Promise<T>,
  paths: string[] = [],
): Promise<FinanceResult<T>> {
  try {
    const userId = await requirePermission(permission);
    const company = await getContainer().companySettings.ensureSeeded();
    await getContainer().reasonCodes.ensureSystemReasons(company.id);
    const h = await headers();
    const ctx: FinanceContext = {
      companyId: company.id,
      actor: { type: 'user', id: userId },
      origin: {
        ...origin,
        permissionUsed: permission,
        requestId: h.get('x-request-id'),
        ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip'),
        userAgent: h.get('user-agent'),
      },
    };
    const data = await fn(ctx, userId);
    for (const p of paths) revalidatePath(p);
    return { ok: true, data };
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError) {
      return { ok: false, error: 'You do not have permission to do that.', forbidden: true };
    }
    if (error instanceof FinanceError) {
      return { ok: false, error: error.message, code: error.code, issues: error.issues };
    }
    if (error instanceof PostingError) {
      return { ok: false, error: error.message, code: error.code, issues: error.issues };
    }
    if (error instanceof ReasonError) return { ok: false, error: error.message, code: error.code };
    const guarded = AmountErrorGuard(error);
    if (guarded) return { ok: false, error: guarded, code: 'AMOUNT_INVALID' };
    console.error('[finance]', error);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}

export async function postingPermissions(): Promise<PostingPermissions> {
  const [soft, control] = await Promise.all([
    canPermission('period:post_to_soft_closed'),
    canPermission('journals:post_to_control_account'),
  ]);
  return { canPostSoftClosed: soft, canPostControlAccounts: control };
}

