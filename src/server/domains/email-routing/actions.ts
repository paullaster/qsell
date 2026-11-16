'use server';

import { getContainer } from '@/server/di/container';
import { runSetting } from '@/server/domains/settings/action-runner';
import { ReasonError } from '@/server/kernel/reason-codes/service';
import { EmailRoutingError, type PointView } from './email-route-service';

const PATHS = ['/admin/settings/email-routing'];
const friendly = (error: unknown): string | null => (error instanceof EmailRoutingError || error instanceof ReasonError ? error.message : null);
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const reasonOf = (value: unknown): { code: string; text?: string } => {
  const r = obj(value);
  const code = typeof r.code === 'string' ? r.code : '';
  return typeof r.text === 'string' ? { code, text: r.text } : { code };
};

/** Every email point as the screen shows it: who it goes to now, and what has been changed from the built-in behaviour. */
export async function emailRoutingScreenAction() {
  return await runSetting('email_routing:manage', async ({ companyId }): Promise<PointView[]> => await getContainer().emailRoutes.screen(companyId), { friendly });
}

/** Saves one point, then returns the screen again so it shows what was kept. */
export async function saveEmailRouteAction(point: unknown, raw: unknown, reason: unknown) {
  return await runSetting(
    'email_routing:manage',
    async ({ companyId, userId }): Promise<PointView[]> => {
      const c = getContainer();
      await c.reasonCodes.ensureSystemReasons(companyId);
      await c.emailRoutes.save(companyId, point, raw, { type: 'user', id: userId }, reasonOf(reason));
      return await c.emailRoutes.screen(companyId);
    },
    { paths: PATHS, friendly },
  );
}

/** Puts one point back to the built-in behaviour. */
export async function resetEmailRouteAction(point: unknown, reason: unknown) {
  return await runSetting(
    'email_routing:manage',
    async ({ companyId, userId }): Promise<PointView[]> => {
      const c = getContainer();
      await c.reasonCodes.ensureSystemReasons(companyId);
      await c.emailRoutes.reset(companyId, point, { type: 'user', id: userId }, reasonOf(reason));
      return await c.emailRoutes.screen(companyId);
    },
    { paths: PATHS, friendly },
  );
}
