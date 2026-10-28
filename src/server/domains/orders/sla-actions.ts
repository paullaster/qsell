'use server';

import { runSetting } from '@/server/domains/settings/action-runner';
import { SettingsError } from '@/server/domains/settings/errors';
import { getContainer } from '@/server/di/container';
import { ORDER_STAGES } from '@/lib/order-stages';
import { checkAddresses, checkTarget } from '@/lib/order-sla';
import type { BreachView } from './sla-service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

export interface TargetForm {
  stage: string;
  label: string;
  targetMinutes: number;
  escalateAfterMinutes: number;
  enabled: boolean;
}
export interface OrderTargetsForm {
  targets: TargetForm[];
  raiseEmails: string;
  escalateEmails: string;
}

/** The targets in force and who is mailed. Needs `orders:sla_manage`. */
export async function orderTargetsAction() {
  return await runSetting('orders:sla_manage', async (ctx): Promise<OrderTargetsForm> => {
    const s = await getContainer().orderSla.settings(ctx.companyId);
    return {
      targets: s.targets.map((t) => ({ ...t, label: ORDER_STAGES[t.stage].label })),
      raiseEmails: s.raiseEmails.join('\n'),
      escalateEmails: s.escalateEmails.join('\n'),
    };
  });
}

/** Saves every target and both address lists, or nothing: the first problem found is returned in words. */
export async function saveOrderTargetsAction(input: unknown) {
  return await runSetting(
    'orders:sla_manage',
    async (ctx) => {
      const body = obj(input);
      if (!Array.isArray(body.targets) || body.targets.length === 0 || body.targets.length > 40) throw new SettingsError('There are no targets to save.', 'NO_TARGETS');
      const targets = body.targets.map((raw) => {
        const row = obj(raw);
        const checked = checkTarget({ stage: row.stage, targetMinutes: row.targetMinutes, escalateAfterMinutes: row.escalateAfterMinutes, enabled: row.enabled });
        if (!checked.ok) throw new SettingsError(checked.error, 'BAD_TARGET');
        return checked.target;
      });
      const raise = checkAddresses(body.raiseEmails);
      if (!raise.ok) throw new SettingsError(`Late orders: ${raise.error}`, 'BAD_ADDRESS');
      const escalate = checkAddresses(body.escalateEmails);
      if (!escalate.ok) throw new SettingsError(`Escalations: ${escalate.error}`, 'BAD_ADDRESS');
      await getContainer().orderSla.save(ctx.companyId, ctx.userId, targets, raise.addresses, escalate.addresses);
      return { saved: targets.length };
    },
    { paths: ['/admin/settings/order-targets'] },
  );
}

/** Orders that are waiting longer than their target, oldest first. Needs `orders:timeline`. */
export async function lateOrdersAction(cursor?: unknown) {
  return await runSetting('orders:timeline', async (ctx): Promise<{ rows: BreachView[]; nextCursor: string | null }> => {
    const after = typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 400 ? cursor : null;
    return await getContainer().orderSla.open(ctx.companyId, after, new Date());
  });
}

/** "I have seen this and am on it." Needs `orders:update`. */
export async function acknowledgeLateOrderAction(breachId: unknown, note: unknown) {
  return await runSetting('orders:update', async (ctx) => {
    if (typeof breachId !== 'string' || !UUID.test(breachId)) throw new SettingsError('That late order could not be found.', 'NOT_FOUND');
    await getContainer().orderSla.acknowledge(ctx.companyId, ctx.userId, breachId, typeof note === 'string' ? note : '');
    return { acknowledged: true };
  });
}
