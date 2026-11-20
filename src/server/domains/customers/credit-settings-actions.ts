'use server';

import { getContainer } from '@/server/di/container';
import { runSetting } from '@/server/domains/settings/action-runner';
import { ReasonError } from '@/server/kernel/reason-codes/service';
import {
  CustomerCreditSettingsError,
  type CustomerCreditSettingsView,
} from './customer-credit-settings-service';

const PATHS = ['/admin/settings/sales/customer'];
const friendly = (error: unknown): string | null =>
  error instanceof CustomerCreditSettingsError || error instanceof ReasonError
    ? error.message
    : null;
const obj = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
const reasonOf = (value: unknown): { code: string; text?: string } => {
  const r = obj(value);
  const code = typeof r.code === 'string' ? r.code : '';
  return typeof r.text === 'string' ? { code, text: r.text } : { code };
};

export interface CustomerCreditSettingsActionView extends CustomerCreditSettingsView {
  pending: boolean;
  message: string | null;
}

const withStatus = (
  view: CustomerCreditSettingsView,
  message: string | null = null,
): CustomerCreditSettingsActionView => ({ ...view, pending: message !== null, message });

export async function customerCreditSettingsScreenAction() {
  return await runSetting(
    'selling_settings:manage',
    async ({ companyId }): Promise<CustomerCreditSettingsActionView> =>
      withStatus(await getContainer().customerCreditSettings.get(companyId)),
    { friendly },
  );
}

export async function saveCustomerCreditDisplayAction(raw: unknown, reason: unknown) {
  return await runSetting(
    'selling_settings:manage',
    async ({ companyId, userId }): Promise<CustomerCreditSettingsActionView> => {
      const c = getContainer();
      await c.reasonCodes.ensureSystemReasons(companyId);
      return withStatus(
        await c.customerCreditSettings.saveDisplay(
          companyId,
          raw,
          { type: 'user', id: userId },
          reasonOf(reason),
        ),
      );
    },
    { paths: PATHS, friendly },
  );
}

export async function setAllowOverCreditLimitAction(enabled: unknown, reason: unknown) {
  return await runSetting(
    'selling_settings:manage',
    async ({ companyId, userId }): Promise<CustomerCreditSettingsActionView> => {
      const c = getContainer();
      await c.reasonCodes.ensureSystemReasons(companyId);
      const next = enabled === true;
      const why = reasonOf(reason);
      if (!next)
        return withStatus(
          await c.customerCreditSettings.setAllowOverCreditLimit(companyId, false, why, {
            type: 'user',
            id: userId,
          }),
        );
      const gate = await c.approvalGate.gate(
        {
          trigger: 'customer_credit_settings.enable_over_limit',
          companyId,
          requestedBy: userId,
          amount: 0,
          facts: { allowOverCreditLimit: true },
          action: 'enable_over_limit',
          payload: { companyId, enabled: true, reason: why },
          summary: 'Allow customers to place orders beyond their available credit limit.',
        },
        async () =>
          await c.customerCreditSettings.setAllowOverCreditLimit(companyId, true, why, {
            type: 'user',
            id: userId,
          }),
      );
      return gate.parked
        ? withStatus(await c.customerCreditSettings.get(companyId), gate.message)
        : withStatus(gate.value);
    },
    { paths: PATHS, friendly },
  );
}
