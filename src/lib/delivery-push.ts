/** Pure rules for the push alerts about lateness: what an alert says, and what a browser's subscription must look like. */

import { LEVEL_WORDS, lateWords, windowWords, type EscalationLevel } from '@/lib/delivery-sla';

export interface Alert {
  title: string;
  body: string;
}

/** The alert for a level. It names the delivery and the window and how late, never the address, phone, items or any payment. */
export function lateAlert(input: { level: EscalationLevel; number: string; windowStart: Date | null; windowEnd: Date | null; minutesLate: number }): Alert {
  const window = input.windowStart !== null && input.windowEnd !== null ? windowWords(input.windowStart, input.windowEnd) : 'no window';
  const state = input.level === 'at_risk' ? 'is at risk' : 'is late';
  const how = input.level === 'at_risk' ? 'Not late yet' : `Late by ${lateWords(input.minutesLate)}`;
  return { title: `Delivery ${input.number} ${state}`.slice(0, 80), body: `${LEVEL_WORDS[input.level]}. Promised ${window}. ${how}.`.slice(0, 200) };
}

export interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/** A browser's subscription as it arrives from the phone: an https address and the two keys, within sane sizes. */
export function readSubscription(raw: unknown): { ok: true; value: Subscription } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'This browser did not give a valid subscription.' };
  const r = raw as Record<string, unknown>;
  const endpoint = typeof r.endpoint === 'string' ? r.endpoint.trim() : '';
  const p256dh = typeof r.p256dh === 'string' ? r.p256dh.trim() : '';
  const auth = typeof r.auth === 'string' ? r.auth.trim() : '';
  if (endpoint.length < 10 || endpoint.length > 2048 || !endpoint.startsWith('https://')) return { ok: false, error: 'This browser did not give a valid subscription.' };
  if (p256dh.length < 20 || p256dh.length > 200 || !B64URL.test(p256dh) || auth.length < 8 || auth.length > 100 || !B64URL.test(auth)) return { ok: false, error: 'This browser did not give a valid subscription.' };
  return { ok: true, value: { endpoint, p256dh, auth } };
}
