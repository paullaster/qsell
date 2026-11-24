'use server';

import { getContainer } from '@/server/di/container';
import { runSetting } from '@/server/domains/settings/action-runner';
import { ReasonError } from '@/server/kernel/reason-codes/service';
import { VanSalesError, type VanSalesScreen } from './settings-service';

const friendly = (error: unknown): string | null => (error instanceof VanSalesError || error instanceof ReasonError ? error.message : null);
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const reasonOf = (value: unknown): { code: string; text?: string } => {
  const r = obj(value);
  const code = typeof r.code === 'string' ? r.code : '';
  return typeof r.text === 'string' ? { code, text: r.text } : { code };
};

/** The van sales settings screen: which modes are on and the rules of a van day. */
export async function vanSalesSettingsScreenAction() {
  return await runSetting('van_sales:settings', async ({ companyId }): Promise<VanSalesScreen> => await getContainer().vanSalesSettings.screen(companyId), { friendly });
}

/** Changes them, with a reason and the version that was on screen. */
export async function saveVanSalesSettingsAction(raw: unknown, expectedVersion: unknown, reason: unknown) {
  return await runSetting(
    'van_sales:settings',
    async ({ companyId, userId }): Promise<VanSalesScreen> => {
      const c = getContainer();
      await c.reasonCodes.ensureSystemReasons(companyId);
      return await c.vanSalesSettings.save(companyId, { type: 'user', id: userId }, raw, expectedVersion, reasonOf(reason));
    },
    { paths: ['/admin/settings/sales/van-sales'], friendly },
  );
}
