/** Who may carry deliveries, and the words for it. Pure: the rules apart from the database. */

export const RIDER_KINDS = ['staff', 'separate'] as const;
export type RiderKind = (typeof RIDER_KINDS)[number];

export const RIDER_STATUSES = ['active', 'paused', 'ended'] as const;
export type RiderStatus = (typeof RIDER_STATUSES)[number];

export const RIDER_KIND_WORDS: Record<RiderKind, string> = {
  staff: 'Staff member',
  separate: 'Own rider account',
};

export const RIDER_KIND_HELP: Record<RiderKind, string> = {
  staff: 'A member of staff signs in with the account they already have and opens the rider app from it.',
  separate: 'The rider has an account made only for riding. It opens the rider app and nothing else.',
};

export const RIDER_STATUS_WORDS: Record<RiderStatus, string> = {
  active: 'Riding',
  paused: 'Paused',
  ended: 'Left',
};

export interface RiderKinds {
  allowStaff: boolean;
  allowSeparate: boolean;
}

export const isRiderKind = (value: unknown): value is RiderKind => typeof value === 'string' && (RIDER_KINDS as readonly string[]).includes(value);

export const kindAllowed = (kinds: RiderKinds, kind: RiderKind): boolean => (kind === 'staff' ? kinds.allowStaff : kinds.allowSeparate);

/** The kinds a company uses, in words. */
export function kindsInWords(kinds: RiderKinds): string {
  if (kinds.allowStaff && kinds.allowSeparate) return 'staff and riders with their own accounts';
  if (kinds.allowSeparate) return 'riders with their own accounts';
  return 'staff';
}

/** Why a choice of kinds cannot be saved, or null. A kind cannot be switched off while people of that kind are still riding. */
export function kindsProblem(next: RiderKinds, working: Record<RiderKind, number>): string | null {
  if (!next.allowStaff && !next.allowSeparate) return 'Choose at least one: staff, or riders with their own accounts.';
  if (!next.allowStaff && working.staff > 0) return `${String(working.staff)} staff ${working.staff === 1 ? 'member is' : 'members are'} still riding. Take them off riding first, or keep staff switched on.`;
  if (!next.allowSeparate && working.separate > 0) return `${String(working.separate)} ${working.separate === 1 ? 'rider has' : 'riders have'} an account of their own. End ${working.separate === 1 ? 'it' : 'them'} first, or keep own accounts switched on.`;
  return null;
}

/** Whether a person may be given a run: riding, on the kind the company still uses. */
export function mayCarry(rider: { status: RiderStatus; kind: RiderKind }, kinds: RiderKinds): boolean {
  return rider.status === 'active' && kindAllowed(kinds, rider.kind);
}

export type RiderChange = 'pause' | 'resume' | 'end';

/** The status a change leads to, or null when the change does not apply from here. */
export function riderStatusAfter(from: RiderStatus, change: RiderChange): RiderStatus | null {
  if (change === 'pause') return from === 'active' ? 'paused' : null;
  if (change === 'resume') return from === 'active' ? null : 'active';
  return from === 'ended' ? null : 'ended';
}

/** A phone number as the rider app would dial it: digits and a leading plus only. Null when it is too short to be a number. */
export function dialable(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = value.replace(/[^\d+]/g, '');
  const digits = cleaned.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? cleaned : null;
}
