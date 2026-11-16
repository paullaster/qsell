'use server';

import { getContainer } from '@/server/di/container';
import { runSetting } from '@/server/domains/settings/action-runner';
import { ReasonError } from '@/server/kernel/reason-codes/service';
import { SellingSettingsError, type SellingTypeView } from './selling-settings-service';

const PATHS = ['/admin/settings/selling-documents'];
const friendly = (error: unknown): string | null => (error instanceof SellingSettingsError || error instanceof ReasonError ? error.message : null);
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const reasonOf = (value: unknown): { code: string; text?: string } => {
  const r = obj(value);
  const code = typeof r.code === 'string' ? r.code : '';
  return typeof r.text === 'string' ? { code, text: r.text } : { code };
};

/** Every selling document type with its behaviour now, for the settings screen. */
export async function sellingSettingsScreenAction() {
  return await runSetting('selling_settings:manage', async ({ companyId }): Promise<SellingTypeView[]> => await getContainer().sellingSettings.screen(companyId), { friendly });
}

/** Saves one type's behaviour, then returns the screen again so it shows what was kept. */
export async function saveSellingSettingsAction(type: unknown, raw: unknown, reason: unknown) {
  return await runSetting(
    'selling_settings:manage',
    async ({ companyId, userId }): Promise<SellingTypeView[]> => {
      const c = getContainer();
      await c.reasonCodes.ensureSystemReasons(companyId);
      await c.sellingSettings.save(companyId, type, raw, { type: 'user', id: userId }, reasonOf(reason));
      return await c.sellingSettings.screen(companyId);
    },
    { paths: PATHS, friendly },
  );
}

/** Puts one type back to its built-in behaviour. */
export async function resetSellingSettingsAction(type: unknown, reason: unknown) {
  return await runSetting(
    'selling_settings:manage',
    async ({ companyId, userId }): Promise<SellingTypeView[]> => {
      const c = getContainer();
      await c.reasonCodes.ensureSystemReasons(companyId);
      await c.sellingSettings.reset(companyId, type, { type: 'user', id: userId }, reasonOf(reason));
      return await c.sellingSettings.screen(companyId);
    },
    { paths: PATHS, friendly },
  );
}
