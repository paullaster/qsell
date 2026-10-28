import { ORDER_STAGES, STUCK_RULES, type OrderStage } from '@/lib/order-stages';
import { has } from '@/lib/values';

/**
 * Targets for how long an order may wait in a stage, and when a wait becomes a breach and then an escalation. Pure: the clock and
 * the stored overrides come in as parameters. Design: docs/architecture/order-stage-timeline.md §14.
 */

export const MIN_TARGET_MINUTES = 5;
export const MAX_TARGET_MINUTES = 90 * 24 * 60;
export const MIN_ESCALATE_MINUTES = 5;
export const MAX_ESCALATE_MINUTES = 30 * 24 * 60;
export const MAX_NOTIFY_ADDRESSES = 10;

/** The stages an order can sit in and wait for something. Finished stages (completed, cancelled ...) never have a target. */
export const WAITING_STAGES = [
  'payment_started',
  'approval_requested',
  'payment_confirmed',
  'released_for_fulfilment',
  'blocked',
  'pick_started',
  'picked',
  'packed',
  'ready',
  'dispatched',
  'out_for_delivery',
] as const satisfies readonly OrderStage[];
export type WaitingStage = (typeof WAITING_STAGES)[number];

export function isWaitingStage(value: unknown): value is WaitingStage {
  return typeof value === 'string' && (WAITING_STAGES as readonly string[]).includes(value);
}

export interface StageTarget {
  stage: WaitingStage;
  /** Minutes in the stage before it counts as late. */
  targetMinutes: number;
  /** Minutes after the breach before the second alert. */
  escalateAfterMinutes: number;
  enabled: boolean;
}

/** What a stored override holds. A stage with no row uses the default. */
export interface StoredTarget {
  stage: string;
  targetMinutes: number;
  escalateAfterMinutes: number;
  enabled: boolean;
}

/** The targets in force when a company has changed nothing: the old stuck-order rules, only those switched on. */
export const DEFAULT_TARGETS: readonly StageTarget[] = WAITING_STAGES.map((stage) => {
  const rule = STUCK_RULES.find((r) => r.stage === stage);
  return {
    stage,
    targetMinutes: rule?.olderThanMinutes ?? 24 * 60,
    escalateAfterMinutes: Math.max(MIN_ESCALATE_MINUTES, Math.min(MAX_ESCALATE_MINUTES, Math.round((rule?.olderThanMinutes ?? 24 * 60) / 2))),
    enabled: rule !== undefined,
  };
});

/** Every waiting stage with the target in force: the stored override when there is one, else the default. */
export function effectiveTargets(stored: readonly StoredTarget[]): StageTarget[] {
  return DEFAULT_TARGETS.map((fallback) => {
    const row = stored.find((s) => s.stage === fallback.stage);
    return row === undefined ? fallback : { stage: fallback.stage, targetMinutes: row.targetMinutes, escalateAfterMinutes: row.escalateAfterMinutes, enabled: row.enabled };
  });
}

export interface TargetInput {
  stage: unknown;
  targetMinutes: unknown;
  escalateAfterMinutes: unknown;
  enabled: unknown;
}

export type TargetCheck = { ok: true; target: StageTarget } | { ok: false; error: string };

const wholeMinutes = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null);

/** Checks one target as typed. The browser checks for convenience; the server uses this for real. */
export function checkTarget(input: TargetInput): TargetCheck {
  if (!isWaitingStage(input.stage)) return { ok: false, error: 'Choose a stage that an order can wait in.' };
  const label = ORDER_STAGES[input.stage].label;
  const target = wholeMinutes(input.targetMinutes);
  if (target === null || target < MIN_TARGET_MINUTES || target > MAX_TARGET_MINUTES) {
    return { ok: false, error: `${label}: the target must be a whole number of minutes from ${String(MIN_TARGET_MINUTES)} to ${String(MAX_TARGET_MINUTES)} (90 days).` };
  }
  const escalate = wholeMinutes(input.escalateAfterMinutes);
  if (escalate === null || escalate < MIN_ESCALATE_MINUTES || escalate > MAX_ESCALATE_MINUTES) {
    return { ok: false, error: `${label}: escalate after a whole number of minutes from ${String(MIN_ESCALATE_MINUTES)} to ${String(MAX_ESCALATE_MINUTES)} (30 days).` };
  }
  if (typeof input.enabled !== 'boolean') return { ok: false, error: `${label}: say whether the target is on or off.` };
  return { ok: true, target: { stage: input.stage, targetMinutes: target, escalateAfterMinutes: escalate, enabled: input.enabled } };
}

const ADDRESS = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** Reads a list of mail addresses typed one per line or separated by commas. Returns the clean list or what is wrong. */
export function checkAddresses(raw: unknown): { ok: true; addresses: string[] } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'Addresses must be text.' };
  const parts = raw
    .split(/[\n,;]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(has);
  const unique = [...new Set(parts)];
  if (unique.length > MAX_NOTIFY_ADDRESSES) return { ok: false, error: `Use at most ${String(MAX_NOTIFY_ADDRESSES)} addresses.` };
  const bad = unique.find((a) => a.length > 254 || !ADDRESS.test(a));
  return bad === undefined ? { ok: true, addresses: unique } : { ok: false, error: `"${bad}" is not an email address.` };
}

export type BreachLevel = 'none' | 'breached' | 'escalate';

/** Where a wait stands: not late, late, or late for longer than the escalation time. `since` and `now` are instants. */
export function breachLevel(target: StageTarget, since: Date, now: Date): BreachLevel {
  if (!target.enabled) return 'none';
  const waited = (now.getTime() - since.getTime()) / 60_000;
  if (waited < target.targetMinutes) return 'none';
  return waited >= target.targetMinutes + target.escalateAfterMinutes ? 'escalate' : 'breached';
}

/** The instant a wait that began at `since` becomes a breach. */
export function breachAt(target: StageTarget, since: Date): Date {
  return new Date(since.getTime() + target.targetMinutes * 60_000);
}

/** How long a wait lasted (or has lasted), in whole minutes, never negative. */
export function waitedMinutes(since: Date, until: Date): number {
  return Math.max(0, Math.floor((until.getTime() - since.getTime()) / 60_000));
}

/** "2 h 05 min", "3 days 4 h": for people. */
export function durationWords(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${String(m)} min`;
  if (m < 24 * 60) return `${String(Math.floor(m / 60))} h ${String(m % 60).padStart(2, '0')} min`;
  const days = Math.floor(m / (24 * 60));
  return `${String(days)} ${days === 1 ? 'day' : 'days'} ${String(Math.floor((m % (24 * 60)) / 60))} h`;
}
