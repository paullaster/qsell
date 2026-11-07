/**
 * Promised windows and lateness: whether a delivery that was promised a window is on track, at risk, late, or was met or missed, and how
 * far a late one has gone up the chain (first the dispatcher, then the supervisor). Rules only; a worker raises the events and the
 * screens show them.
 */

export const SLA_STATES = ['on_track', 'at_risk', 'late', 'met', 'missed'] as const;
export type SlaState = (typeof SLA_STATES)[number];

export const SLA_WORDS: Record<SlaState, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  late: 'Late',
  met: 'On time',
  missed: 'Delivered late',
};

export const MAX_AT_RISK_MINUTES = 24 * 60;
export const MAX_ESCALATE_MINUTES = 24 * 60;
export const DEFAULT_AT_RISK_MINUTES = 60;
export const DEFAULT_ESCALATE_MINUTES = 60;

/** Where a delivery stands against what was promised, or null when nothing was promised or it is no longer expected (cancelled, returned). */
export function slaState(input: { windowStart: Date | null; windowEnd: Date | null; status: string; deliveredAt: Date | null; now: Date; atRiskMinutes: number }): SlaState | null {
  const { windowStart, windowEnd, status, deliveredAt, now, atRiskMinutes } = input;
  if (windowStart === null || windowEnd === null) return null;
  if (status === 'cancelled' || status === 'returned') return null;
  if (status === 'delivered') return deliveredAt !== null && deliveredAt.getTime() > windowEnd.getTime() ? 'missed' : 'met';
  const t = now.getTime();
  if (t > windowEnd.getTime()) return 'late';
  // Close to the end of the window, or the window has begun and it is not yet on its way.
  if (t >= windowEnd.getTime() - atRiskMinutes * 60_000) return 'at_risk';
  if (t >= windowStart.getTime() && status !== 'out_for_delivery') return 'at_risk';
  return 'on_track';
}

export type EscalationLevel = 'at_risk' | 'late' | 'escalated';

export const LEVEL_WORDS: Record<EscalationLevel, string> = {
  at_risk: 'At risk: the dispatcher is told',
  late: 'Late: the dispatcher is told',
  escalated: 'Still late: the supervisor is told',
};

/** The levels a delivery has reached by now, in order: at risk, then late, then escalated once it has been late for the set time. */
export function levelsReached(input: { state: SlaState | null; windowEnd: Date | null; now: Date; escalateAfterMinutes: number }): EscalationLevel[] {
  const { state, windowEnd, now, escalateAfterMinutes } = input;
  if (state === null || windowEnd === null || state === 'on_track' || state === 'met' || state === 'missed') return [];
  if (state === 'at_risk') return ['at_risk'];
  const lateBy = (now.getTime() - windowEnd.getTime()) / 60_000;
  return lateBy >= escalateAfterMinutes ? ['at_risk', 'late', 'escalated'] : ['at_risk', 'late'];
}

/** How late, in words: "12 minutes", "2 hours 5 min", "1 day". */
export function lateWords(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${String(m)} ${m === 1 ? 'minute' : 'minutes'}`;
  const days = Math.floor(m / 1440);
  const hours = Math.floor((m % 1440) / 60);
  const rest = m % 60;
  return [days > 0 ? `${String(days)} ${days === 1 ? 'day' : 'days'}` : '', hours > 0 ? `${String(hours)} ${hours === 1 ? 'hour' : 'hours'}` : '', rest > 0 && days === 0 ? `${String(rest)} min` : ''].filter((p) => p !== '').join(' ');
}

export type SlaSettingsInput = { ok: true; atRiskMinutes: number; escalateAfterMinutes: number } | { ok: false; error: string };

export function checkSlaSettings(raw: { atRiskMinutes?: unknown; escalateAfterMinutes?: unknown }): SlaSettingsInput {
  const a = raw.atRiskMinutes;
  const e = raw.escalateAfterMinutes;
  if (typeof a !== 'number' || !Number.isInteger(a) || a < 0 || a > MAX_AT_RISK_MINUTES) return { ok: false, error: 'Warn this many minutes before the window ends: a whole number from 0 to 1,440.' };
  if (typeof e !== 'number' || !Number.isInteger(e) || e < 1 || e > MAX_ESCALATE_MINUTES) return { ok: false, error: 'Tell the supervisor after this many minutes late: a whole number from 1 to 1,440.' };
  return { ok: true, atRiskMinutes: a, escalateAfterMinutes: e };
}

/** The window as the customer is told it: "Thu 5 Nov, 09:00 to 12:00" (Nairobi time). */
export function windowWords(start: Date, end: Date): string {
  const day = start.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Nairobi' });
  const time = (d: Date): string => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Nairobi' });
  return `${day}, ${time(start)} to ${time(end)}`;
}
