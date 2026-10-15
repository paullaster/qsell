import { revalidatePath } from 'next/cache';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { requirePermission } from '@/server/domains/access-control/guard';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { getContainer } from '@/server/di/container';
import { injectedDelay } from '@/server/domains/finance/action-runner';
import { SettingsError } from './errors';

export { SettingsError } from './errors';

export type SettingsResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string; forbidden?: true };

export interface SettingsContext {
  companyId: string;
  userId: string;
}

/**
 * Every settings action goes through here: one explicit permission per action, the company and the
 * person set on the server, and failures returned as data (server-action errors are masked in
 * production). Errors that carry words for the person (`SettingsError` and its subclasses) are
 * shown; anything else is logged and answered in general words.
 */
export async function runSetting<T>(
  permission: PermissionKey,
  fn: (ctx: SettingsContext) => Promise<T>,
  options: { paths?: string[]; friendly?: (error: unknown) => string | null } = {},
): Promise<SettingsResult<T>> {
  try {
    await injectedDelay();
    const userId = await requirePermission(permission);
    const company = await getContainer().companySettings.ensureSeeded();
    const data = await fn({ companyId: company.id, userId });
    for (const path of options.paths ?? []) revalidatePath(path);
    return { ok: true, data };
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError) return { ok: false, error: 'You do not have permission to do that.', forbidden: true };
    if (error instanceof SettingsError) return { ok: false, error: error.message, code: error.code };
    const friendly = options.friendly?.(error) ?? null;
    if (friendly !== null) return { ok: false, error: friendly };
    console.error('[settings]', error);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}
