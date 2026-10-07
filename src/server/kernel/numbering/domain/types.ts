export type SeriesMode = 'gap_free' | 'allow_gaps';
export type ResetPolicy = 'never' | 'yearly' | 'monthly';

/** The part of a series line the pure logic needs. Dates are ISO `YYYY-MM-DD` strings. */
export interface LineConfig {
  id: string;
  lineNo: number;
  /** Null: applies to every branch. */
  branchId: string | null;
  startsOn: string;
  endsOn: string | null;
  prefix: string;
  suffix: string;
  digits: number;
  startNo: number;
  endNo: number | null;
  increment: number;
  warnAt: number | null;
  reset: ResetPolicy;
  isOpen: boolean;
}

/** Why a line was or was not used for a request. Part of every allocation's trace. */
export interface ConsideredLine {
  lineNo: number;
  accepted: boolean;
  reason: string;
}

export interface Issue {
  field: string;
  message: string;
}

/** The largest number of digits a sequence may have, so values stay exact in JavaScript. */
export const MAX_DIGITS = 15;
