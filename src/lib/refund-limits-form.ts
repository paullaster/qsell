import type { RefundLimitValues } from '@/server/domains/finance/domain/refund-limits';

/** What a person types on the refund limits screen, turned into limits, in words when it is wrong. Pure; the server checks again. */
export interface LimitsForm {
  enabled: boolean;
  windowHours: string;
  maxPerCustomer: string;
  maxAmountPerCustomer: string;
  maxPerDestination: string;
  maxPerRequester: string;
  maxAmountPerRequester: string;
  mode: string;
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function count(text: string, label: string): Checked<number | null> {
  const t = text.trim();
  if (t === '') return { ok: true, value: null };
  if (!/^\d{1,6}$/.test(t) || Number(t) < 1)
    return {
      ok: false,
      error: `${label} must be a whole number of 1 or more, or left empty for no limit.`,
    };
  return { ok: true, value: Number(t) };
}

function amount(text: string, label: string): Checked<number | null> {
  const t = text.trim().replace(/,/g, '');
  if (t === '') return { ok: true, value: null };
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(t) || Number(t) <= 0)
    return {
      ok: false,
      error: `${label} must be an amount above zero with at most 2 decimals, or left empty for no limit.`,
    };
  return { ok: true, value: Math.round(Number(t) * 100) };
}

/** Checks what a person typed. Everything is checked again on the server. */
export function checkLimitsForm(form: LimitsForm): Checked<RefundLimitValues> {
  const window = /^\d{1,3}$/.test(form.windowHours.trim()) ? Number(form.windowHours.trim()) : NaN;
  if (!(window >= 1 && window <= 720))
    return { ok: false, error: 'The window must be between 1 and 720 hours.' };
  if (form.mode !== 'review' && form.mode !== 'refuse')
    return { ok: false, error: 'Choose what happens when a limit is passed.' };
  const parts = {
    maxPerCustomer: count(form.maxPerCustomer, 'Refunds per customer'),
    maxCentsPerCustomer: amount(form.maxAmountPerCustomer, 'Amount per customer'),
    maxPerDestination: count(form.maxPerDestination, 'Refunds per phone number or account'),
    maxPerRequester: count(form.maxPerRequester, 'Refunds per person asking'),
    maxCentsPerRequester: amount(form.maxAmountPerRequester, 'Amount per person asking'),
  };
  for (const part of Object.values(parts)) if (!part.ok) return part;
  const value = (key: keyof typeof parts): number | null => {
    const part = parts[key];
    return part.ok ? part.value : null;
  };
  if (form.enabled && Object.keys(parts).every((k) => value(k as keyof typeof parts) === null)) {
    return { ok: false, error: 'Set at least one limit, or switch the limits off.' };
  }
  return {
    ok: true,
    value: {
      enabled: form.enabled,
      windowHours: window,
      maxPerCustomer: value('maxPerCustomer'),
      maxCentsPerCustomer: value('maxCentsPerCustomer'),
      maxPerDestination: value('maxPerDestination'),
      maxPerRequester: value('maxPerRequester'),
      maxCentsPerRequester: value('maxCentsPerRequester'),
      mode: form.mode,
    },
  };
}

export const LIMIT_MODES = [
  { id: 'review', label: 'Hold the refund for approval, whatever its amount' },
  { id: 'refuse', label: 'Refuse the refund' },
] as const;

export const startingLimitsForm = (v: RefundLimitValues): LimitsForm => ({
  enabled: v.enabled,
  windowHours: String(v.windowHours),
  maxPerCustomer: v.maxPerCustomer === null ? '' : String(v.maxPerCustomer),
  maxAmountPerCustomer:
    v.maxCentsPerCustomer === null ? '' : (v.maxCentsPerCustomer / 100).toFixed(2),
  maxPerDestination: v.maxPerDestination === null ? '' : String(v.maxPerDestination),
  maxPerRequester: v.maxPerRequester === null ? '' : String(v.maxPerRequester),
  maxAmountPerRequester:
    v.maxCentsPerRequester === null ? '' : (v.maxCentsPerRequester / 100).toFixed(2),
  mode: v.mode,
});

function windowWords(hours: number): string {
  if (hours === 24) return 'a day';
  return hours % 24 === 0 ? `${String(hours / 24)} days` : `${String(hours)} hours`;
}

/** The limits in force, in a sentence for the page. */
export function describeLimits(v: RefundLimitValues): string {
  if (!v.enabled) return 'No limits: refunds can be asked for as often as needed.';
  const window = windowWords(v.windowHours);
  const parts: string[] = [];
  if (v.maxPerCustomer !== null) parts.push(`${String(v.maxPerCustomer)} per customer`);
  if (v.maxCentsPerCustomer !== null)
    parts.push(`${(v.maxCentsPerCustomer / 100).toLocaleString('en-KE')} per customer in money`);
  if (v.maxPerDestination !== null)
    parts.push(`${String(v.maxPerDestination)} per phone number or account`);
  if (v.maxPerRequester !== null) parts.push(`${String(v.maxPerRequester)} per person asking`);
  if (v.maxCentsPerRequester !== null)
    parts.push(
      `${(v.maxCentsPerRequester / 100).toLocaleString('en-KE')} per person asking in money`,
    );
  const past =
    v.mode === 'refuse'
      ? 'Past a limit the refund is refused.'
      : 'Past a limit the refund is held for approval, whatever its amount.';
  return `In ${window}: at most ${parts.join(', ')}. ${past}`;
}
