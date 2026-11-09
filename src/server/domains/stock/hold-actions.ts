'use server';

import { getContainer } from '@/server/di/container';
import { canPermission } from '@/server/domains/access-control/guard';
import { DEFAULT_UNPAID_HOLD_MINUTES } from './settings';
import { objectOf, runStock } from './action-support';
import { StockError } from './errors';

export interface UnpaidHoldView {
  /** How long a shop order to be paid at once holds stock; 0 means until it is settled or released. */
  minutes: number;
  defaultMinutes: number;
  canChange: boolean;
}

/** How long an unpaid shop order holds stock, and whether this person can change it. */
export async function unpaidHoldAction() {
  return await runStock('deliveries:read', async (): Promise<UnpaidHoldView> => {
    const c = getContainer();
    return { minutes: (await c.stockSettings.get()).unpaidHoldMinutes, defaultMinutes: DEFAULT_UNPAID_HOLD_MINUTES, canChange: await canPermission('stock:cutover') };
  });
}

/** Chooses how long an unpaid shop order holds stock. It is kept in the decision log. */
export async function setUnpaidHoldAction(raw: unknown) {
  return await runStock(
    'stock:cutover',
    async (ctx): Promise<UnpaidHoldView> => {
      const c = getContainer();
      const minutes = objectOf(raw).minutes;
      if (typeof minutes !== 'number') throw new StockError('Enter the number of minutes.', 'BAD_HOLD');
      const before = (await c.stockSettings.get()).unpaidHoldMinutes;
      await c.stockSettings.setUnpaidHoldMinutes(ctx.companyId, minutes);
      if (minutes !== before) {
        await c.decisionLog.record({ companyId: ctx.companyId, subject: { type: 'stock_settings', id: ctx.companyId }, action: 'stock.unpaid_hold', actor: { type: 'user', id: ctx.userId }, from: String(before), to: String(minutes), reason: { text: minutes === 0 ? 'Unpaid shop orders now hold stock until they are settled or released.' : `Unpaid shop orders now hold stock for ${String(minutes)} minutes.` } });
      }
      return { minutes, defaultMinutes: DEFAULT_UNPAID_HOLD_MINUTES, canChange: true };
    },
    ['/admin/delivery/stock'],
  );
}
