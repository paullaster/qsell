'use server';

import { getContainer } from '@/server/di/container';
import { runSetting } from '@/server/domains/settings/action-runner';
import { ReasonError } from '@/server/kernel/reason-codes/service';
import { BusinessTimeError, type BusinessTimeView } from './business-time-service';

const PATHS = ['/admin/settings/business-time'];
const friendly = (error: unknown): string | null => (error instanceof BusinessTimeError || error instanceof ReasonError ? error.message : null);
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const reasonOf = (value: unknown): { code: string; text?: string } => {
  const r = obj(value);
  const code = typeof r.code === 'string' ? r.code : '';
  return typeof r.text === 'string' ? { code, text: r.text } : { code };
};

/** The business time zone as it stands, for the settings screen. */
export async function businessTimeScreenAction() {
  return await runSetting('timezone:manage', async ({ companyId }): Promise<BusinessTimeView> => await getContainer().businessTime.view(companyId), { friendly });
}

/** Changes the business time zone, with a reason. Only someone with the timezone:manage permission can; the zone is checked on the server. */
export async function saveBusinessTimeAction(timeZone: unknown, reason: unknown) {
  return await runSetting(
    'timezone:manage',
    async ({ companyId, userId }): Promise<BusinessTimeView> => {
      const c = getContainer();
      await c.reasonCodes.ensureSystemReasons(companyId);
      return await c.businessTime.set(companyId, timeZone, { type: 'user', id: userId }, reasonOf(reason));
    },
    { paths: PATHS, friendly },
  );
}
