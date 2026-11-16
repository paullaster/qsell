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

import { internationalPhone } from '@/lib/sms-providers';

export const MAX_NOTIFY_ADDRESSES = 10;
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** Mail addresses as typed (commas, semicolons, spaces or new lines between them): lower case, none twice, at most ten, each a real-looking address. */
export function readAddressList(raw: unknown): { ok: true; addresses: string[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, addresses: [] };
  const parts: unknown = typeof raw === 'string' ? raw.split(/[\s,;]+/) : raw;
  if (!Array.isArray(parts)) return { ok: false, error: 'Type the mail addresses separated by commas.' };
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') return { ok: false, error: 'Type the mail addresses separated by commas.' };
    const a = part.trim().toLowerCase();
    if (a === '') continue;
    if (a.length > 200 || !EMAIL.test(a)) return { ok: false, error: `"${a.slice(0, 60)}" is not a mail address.` };
    if (!out.includes(a)) out.push(a);
  }
  if (out.length > MAX_NOTIFY_ADDRESSES) return { ok: false, error: `At most ${String(MAX_NOTIFY_ADDRESSES)} addresses for each.` };
  return { ok: true, addresses: out };
}

/** Mobile numbers as typed (commas, semicolons, spaces or new lines between them), each written with its country code, none twice, at most ten. */
export function readPhoneList(raw: unknown): { ok: true; numbers: string[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, numbers: [] };
  // A number may be typed with spaces inside it ("0712 345 678"), so only commas, semicolons and new lines separate numbers.
  const parts: unknown = typeof raw === 'string' ? raw.split(/[,;\n]+/) : raw;
  if (!Array.isArray(parts)) return { ok: false, error: 'Type the phone numbers separated by commas.' };
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') return { ok: false, error: 'Type the phone numbers separated by commas.' };
    if (part.trim() === '') continue;
    const n = internationalPhone(part);
    if (n === null) return { ok: false, error: `"${part.trim().slice(0, 30)}" is not a mobile number.` };
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > MAX_NOTIFY_ADDRESSES) return { ok: false, error: `At most ${String(MAX_NOTIFY_ADDRESSES)} numbers for each.` };
  return { ok: true, numbers: out };
}

/** The text message for a level: the delivery, the day and time promised and how late, and the shop. Never the customer, address or payment. */
export function lateText(input: { level: EscalationLevel; number: string; windowStart: Date | null; windowEnd: Date | null; minutesLate: number; shop: string }): string {
  const when = input.windowStart !== null && input.windowEnd !== null ? ` Promised ${windowWords(input.windowStart, input.windowEnd)}.` : '';
  const state = input.level === 'at_risk' ? 'is at risk of being late' : `is late by ${lateWords(input.minutesLate)}`;
  const head = `Delivery ${input.number} ${state}.${when}`;
  const tail = ` ${input.shop.trim()}`;
  // One message part is 160 characters; the shop's name gives way before the facts do.
  return tail.length + head.length <= 160 ? `${head}${tail}` : head.slice(0, 160);
}

/** Who a level is mailed to: the dispatchers for at risk and late, the supervisors when it has gone on too long. */
export const audienceFor = (level: EscalationLevel): 'dispatch' | 'supervisor' => (level === 'escalated' ? 'supervisor' : 'dispatch');

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
