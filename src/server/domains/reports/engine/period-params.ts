import type { PeriodInput } from '../period';
import { asRecord, readShortText, readUuid } from './params';

/** What a report that works over a period asks for: the period, how to compare, and one branch (optional). */
export interface PeriodRequest extends PeriodInput {
  branchId?: string | undefined;
}

/**
 * Reads the period, comparison and branch from an address or a request. The address uses `period` and `branch` (what the
 * filter bar writes); `preset` and `branchId` are accepted as well. Nothing is trusted: each value is cut to length or must
 * be a well-formed id, and the period resolver decides what a short text means.
 */
export function readPeriodParams(raw: unknown): PeriodRequest {
  const input = asRecord(raw);
  return {
    preset: readShortText(input.period ?? input.preset, 20),
    compare: readShortText(input.compare, 20),
    from: readShortText(input.from, 10),
    to: readShortText(input.to, 10),
    branchId: readUuid(input.branch ?? input.branchId),
  };
}
