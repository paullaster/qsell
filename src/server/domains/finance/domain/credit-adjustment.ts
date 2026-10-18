import type { CreditAdjustmentStatus } from '@/server/db/drizzle/schema';

import { has } from '@/lib/values';

/** Credit adjustment rules that need no database. Money is in whole cents. */

const NEXT: Record<CreditAdjustmentStatus, CreditAdjustmentStatus[]> = {
  requested: ['pending_approval', 'applied', 'rejected', 'cancelled'],
  pending_approval: ['applied', 'rejected', 'cancelled', 'requested'],
  applied: [],
  rejected: [],
  cancelled: [],
};

export const nextStatuses = (from: CreditAdjustmentStatus): CreditAdjustmentStatus[] => NEXT[from];

/** The most one adjustment may be, so a typing slip cannot take a fortune: 100 million. */
export const MAX_ADJUSTMENT_CENTS = 10_000_000_000;

export function checkAdjustmentAmount(cents: number): string | null {
  if (!(cents > 0)) return 'The amount must be more than zero.';
  if (cents > MAX_ADJUSTMENT_CENTS) return 'That amount is too large to be right. Check it.';
  return null;
}

/** Whoever decides must be someone other than whoever asked. Returns the problem, or null. */
export function canDecide(p: { requestedBy: string; decidedBy: string | null }): string | null {
  if (!has(p.decidedBy)) return 'Sign in to decide this.';
  return p.decidedBy === p.requestedBy ? 'The person who asked for this cannot be the one who decides it.' : null;
}

/** What can still be done to a request in this state. */
export function adjustmentCapabilities(status: CreditAdjustmentStatus): { decide: boolean; cancel: boolean; submit: boolean } {
  return { decide: status === 'requested', cancel: status === 'requested' || status === 'pending_approval', submit: status === 'requested' };
}
