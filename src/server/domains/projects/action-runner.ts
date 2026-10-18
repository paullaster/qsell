import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { requirePermission } from '@/server/domains/access-control/guard';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { injectedDelay } from '@/server/domains/finance/action-runner';
import { isMalformedId, NO_SUCH_RECORD } from '@/server/domains/settings/errors';
import { getContainer } from '@/server/di/container';
import { NumberSeriesError } from '@/server/kernel/numbering/service';
import { ProjectError } from './errors';
import type { ProjectContext } from './service';

export type ProjectResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string; forbidden?: true };

/**
 * Every project action goes through here: one explicit permission, the company and the person set
 * on the server, and failures returned as data (server-action errors are masked in production).
 */
export async function run<T>(
  permission: PermissionKey,
  origin: { surface: string; action: string },
  fn: (ctx: ProjectContext) => Promise<T>,
  paths: string[] = [],
): Promise<ProjectResult<T>> {
  try {
    await injectedDelay();
    const userId = await requirePermission(permission);
    const company = await getContainer().companySettings.ensureSeeded();
    const h = await headers();
    const ctx: ProjectContext = {
      companyId: company.id,
      actor: { type: 'user', id: userId },
      origin: {
        surface: origin.surface,
        action: origin.action,
        permissionUsed: permission,
        requestId: h.get('x-request-id'),
        ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip'),
        userAgent: h.get('user-agent'),
      },
    };
    const data = await fn(ctx);
    for (const path of paths) revalidatePath(path);
    return { ok: true, data };
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError) return { ok: false, error: 'You do not have permission to do that.', forbidden: true };
    if (error instanceof ProjectError) return { ok: false, error: error.message, code: error.code };
    if (error instanceof NumberSeriesError) return { ok: false, error: error.message, code: error.code };
    if (isMalformedId(error)) return NO_SUCH_RECORD;
    console.error('[projects]', error);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}
