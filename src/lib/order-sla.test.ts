import { describe, expect, it } from 'vitest';
import { STUCK_RULES, isOrderStage } from './order-stages';
import {
  DEFAULT_TARGETS,
  WAITING_STAGES,
  breachAt,
  breachLevel,
  checkAddresses,
  checkTarget,
  durationWords,
  effectiveTargets,
  isWaitingStage,
  waitedMinutes,
  type StageTarget,
} from './order-sla';

const T0 = new Date('2026-10-28T08:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const target: StageTarget = { stage: 'payment_started', targetMinutes: 30, escalateAfterMinutes: 60, enabled: true };

describe('the waiting stages and their defaults', () => {
  it('are all real stages, and every old stuck rule is a waiting stage that starts switched on', () => {
    for (const s of WAITING_STAGES) expect(isOrderStage(s), s).toBe(true);
    for (const rule of STUCK_RULES) {
      const d = DEFAULT_TARGETS.find((t) => t.stage === rule.stage);
      expect(d, rule.stage).toMatchObject({ targetMinutes: rule.olderThanMinutes, enabled: true });
    }
  });
  it('leave the other waiting stages off until a company turns them on', () => {
    const ruled = new Set(STUCK_RULES.map((r) => r.stage as string));
    for (const t of DEFAULT_TARGETS) expect(t.enabled, t.stage).toBe(ruled.has(t.stage));
  });
  it('never include a finished stage', () => {
    for (const s of ['completed', 'cancelled', 'failed', 'refunded', 'delivered'])
      expect(isWaitingStage(s), s).toBe(false);
  });
});

describe('effectiveTargets', () => {
  it('gives every waiting stage once, with an override replacing its default', () => {
    const all = effectiveTargets([{ stage: 'payment_started', targetMinutes: 10, escalateAfterMinutes: 20, enabled: true }]);
    expect(all.map((t) => t.stage)).toEqual([...WAITING_STAGES]);
    expect(all.find((t) => t.stage === 'payment_started')).toMatchObject({ targetMinutes: 10, escalateAfterMinutes: 20 });
    expect(all.find((t) => t.stage === 'dispatched')?.targetMinutes).toBe(72 * 60);
  });
  it('ignores a stored row for a stage that is not a waiting stage', () => {
    expect(effectiveTargets([{ stage: 'completed', targetMinutes: 10, escalateAfterMinutes: 10, enabled: true }])).toHaveLength(WAITING_STAGES.length);
  });
  it('lets an override switch a default off', () => {
    const t = effectiveTargets([{ stage: 'payment_started', targetMinutes: 30, escalateAfterMinutes: 15, enabled: false }]).find((x) => x.stage === 'payment_started');
    expect(t?.enabled).toBe(false);
  });
});

describe('checkTarget', () => {
  const good = { stage: 'packed', targetMinutes: 120, escalateAfterMinutes: 60, enabled: true };
  it('accepts a good target', () => {
    expect(checkTarget(good)).toEqual({ ok: true, target: good });
  });
  it.each([
    [{ ...good, stage: 'completed' }, 'stage'],
    [{ ...good, stage: 7 }, 'stage'],
    [{ ...good, targetMinutes: 4 }, 'target'],
    [{ ...good, targetMinutes: 90 * 24 * 60 + 1 }, 'target'],
    [{ ...good, targetMinutes: 30.5 }, 'target'],
    [{ ...good, targetMinutes: '30' }, 'target'],
    [{ ...good, escalateAfterMinutes: 2 }, 'escalate'],
    [{ ...good, escalateAfterMinutes: 30 * 24 * 60 + 1 }, 'escalate'],
    [{ ...good, escalateAfterMinutes: Number.NaN }, 'escalate'],
    [{ ...good, enabled: 'yes' }, 'on or off'],
  ])('refuses %j (%s)', (input, word) => {
    const r = checkTarget(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toContain(word);
  });
});

describe('checkAddresses', () => {
  it('reads lines and commas, lowercases and removes repeats', () => {
    expect(checkAddresses('Ops@Shop.co.ke, boss@shop.co.ke\nops@shop.co.ke;')).toEqual({ ok: true, addresses: ['ops@shop.co.ke', 'boss@shop.co.ke'] });
  });
  it('accepts an empty list (the company email is used)', () => {
    expect(checkAddresses('  ')).toEqual({ ok: true, addresses: [] });
  });
  it('names the bad address, and refuses more than ten and non-text', () => {
    expect(checkAddresses('a@b.co, nope')).toEqual({ ok: false, error: '"nope" is not an email address.' });
    expect(checkAddresses(Array.from({ length: 11 }, (_, i) => `u${String(i)}@x.co`).join(','))).toMatchObject({ ok: false });
    expect(checkAddresses(5)).toMatchObject({ ok: false });
  });
});

describe('breachLevel and breachAt', () => {
  it('is none before the target, breached from it, escalate after the escalation time', () => {
    expect(breachLevel(target, T0, at(29))).toBe('none');
    expect(breachLevel(target, T0, at(30))).toBe('breached');
    expect(breachLevel(target, T0, at(89))).toBe('breached');
    expect(breachLevel(target, T0, at(90))).toBe('escalate');
  });
  it('is always none when the target is off', () => {
    expect(breachLevel({ ...target, enabled: false }, T0, at(100_000))).toBe('none');
  });
  it('says when the breach begins', () => {
    expect(breachAt(target, T0).toISOString()).toBe('2026-10-28T08:30:00.000Z');
  });
});

describe('time in words', () => {
  it('counts whole minutes and never goes negative', () => {
    expect(waitedMinutes(T0, at(61.9))).toBe(61);
    expect(waitedMinutes(at(5), T0)).toBe(0);
  });
  it.each([
    [0, '0 min'],
    [45, '45 min'],
    [125, '2 h 05 min'],
    [24 * 60 + 90, '1 day 1 h'],
    [3 * 24 * 60 + 4 * 60, '3 days 4 h'],
  ])('%i minutes is %s', (m, words) => {
    expect(durationWords(m)).toBe(words);
  });
});
