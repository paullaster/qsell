'use server';

import { getContainer } from '@/server/di/container';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { parseDay } from './domain/preparation';
import type { PreparationView } from './preparation-service';
import { runSetting } from '@/server/domains/settings/action-runner';

export interface SheetAnswer {
  today: string;
  error: string | null;
  view: PreparationView | null;
}

/**
 * Staff with the right to read orders: what has to be made for a day (or for the orders that have no date). Left empty, the day is
 * today in the company's time.
 */
export async function preparationSheetAction(raw?: unknown) {
  return await runSetting('orders:read', async ({ companyId }): Promise<SheetAnswer> => {
    const today = businessDate();
    const parsed = raw === undefined ? ({ ok: true, day: today } as const) : parseDay(raw);
    if (!parsed.ok) return { today, error: 'That is not a date.', view: null };
    return { today, error: null, view: await getContainer().preparation.forDay(companyId, parsed.day, today) };
  });
}
