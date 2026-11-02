import type { AddressWords } from '@/lib/delivery-zones';
import type { GeoPoint } from '@/lib/geo';
import type { BranchChoiceResult } from '@/lib/branch-choice';

/** Where the order goes, as the customer gave it: a pin, a written address, or both. */
export interface DestinationRecord {
  pin: GeoPoint | null;
  address: AddressWords | null;
  /** How the position that was measured to was found. A placed address is only approximate. */
  positionFrom: 'pin' | 'address' | 'none';
  approximate: boolean;
}

/** Why this branch processes the order, kept with the order so it can still be explained after stock and branches change. */
export interface ChoiceRecord {
  reason: BranchChoiceResult['reason'];
  words: string;
  chosen: {
    branchId: string;
    code: string;
    name: string;
    km: number | null;
    minutes: number | null;
    coversLines: number;
    totalLines: number;
  };
  /** Every branch that was a candidate, best first. */
  ranked: {
    branchId: string;
    code: string;
    km: number | null;
    coversLines: number;
    totalLines: number;
  }[];
  excluded: BranchChoiceResult['excluded'];
  passedOver: string[];
  partial: boolean;
  provider: string;
  degraded: boolean;
}

/** The charge as it was quoted, with how it was worked out. The order and the invoice carry this amount, never a new one. */
export interface ChargeRecord {
  /** As the policy worked it out. With `split`: the charge before tax, the tax, and what the customer paid for delivery. */
  amount: number;
  split: { net: number; tax: number; gross: number };
  taxRate: number;
  currency: string;
  policy: { id: string; code: string; name: string; version: number; method: string };
  zone: { id: string; code: string; name: string; by: 'pin' | 'address' } | null;
  route: {
    km: number;
    minutes: number | null;
    provider: string;
    degraded: boolean;
    approximate: boolean;
  } | null;
  steps: { label: string; amount: number }[];
}
