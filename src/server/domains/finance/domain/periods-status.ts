import type { PeriodStatus } from './types';

/** Which permission moves a period from one status to another (null = not allowed). */
export function periodTransition(
  from: PeriodStatus,
  to: PeriodStatus,
): { permission: string; reasonRequired: boolean } | null {
  if (from === to) return null;
  if (from === 'locked') return null;
  if (from === 'open' && to === 'soft_closed') return { permission: 'period:soft_close', reasonRequired: false };
  if (from === 'soft_closed' && to === 'closed') return { permission: 'period:close', reasonRequired: false };
  if (from === 'open' && to === 'closed') return { permission: 'period:close', reasonRequired: false };
  if (to === 'locked' && from === 'closed') return { permission: 'period:lock', reasonRequired: true };
  if (to === 'open' && (from === 'soft_closed' || from === 'closed')) {
    return { permission: 'period:reopen', reasonRequired: true };
  }
  if (to === 'soft_closed' && from === 'closed') return { permission: 'period:reopen', reasonRequired: true };
  return null;
}
