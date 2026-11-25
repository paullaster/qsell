import { describe, expect, it } from 'vitest';
import { DAY_EVENT_WORDS, DAY_MOVES, DAY_STATUSES, DAY_STATUS_WORDS, VISIT_STATUSES, VISIT_STATUS_WORDS, canArrangeVisits, canMoveDay, isOpenDay, modesLacking, readDayStatus, readPlan } from './days';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('the life of a van day', () => {
  it('goes planned, being loaded, out, back, counted, closed, and is cancelled only before it goes out', () => {
    expect(DAY_MOVES.planned).toEqual(['loading', 'out', 'cancelled']);
    expect(DAY_MOVES.loading).toEqual(['out', 'cancelled']);
    expect(DAY_MOVES.out).toEqual(['returning']);
    expect(DAY_MOVES.returning).toEqual(['reconciling']);
    expect(DAY_MOVES.reconciling).toEqual(['closed']);
    expect(DAY_MOVES.closed).toEqual([]);
    expect(DAY_MOVES.cancelled).toEqual([]);
  });
  it('allows only the moves in the table, never backwards and never a skip', () => {
    for (const from of DAY_STATUSES) for (const to of DAY_STATUSES) expect(canMoveDay(from, to), `${from} to ${to}`).toBe(DAY_MOVES[from].includes(to));
    expect(canMoveDay('out', 'cancelled')).toBe(false);
    expect(canMoveDay('planned', 'returning')).toBe(false);
    expect(canMoveDay('closed', 'planned')).toBe(false);
  });
  it('holds the rep and van until it is closed or cancelled', () => {
    expect(DAY_STATUSES.filter(isOpenDay)).toEqual(['planned', 'loading', 'out', 'returning', 'reconciling']);
  });
  it('lets the visits be arranged only while it is being got ready', () => {
    expect(DAY_STATUSES.filter(canArrangeVisits)).toEqual(['planned', 'loading']);
  });
  it('has words for every state, visit state and history entry, and reads a state back', () => {
    for (const s of DAY_STATUSES) expect(DAY_STATUS_WORDS[s].length).toBeGreaterThan(3);
    for (const s of VISIT_STATUSES) expect(VISIT_STATUS_WORDS[s].length).toBeGreaterThan(3);
    for (const [k, v] of Object.entries(DAY_EVENT_WORDS)) expect(`${k}: ${v}`).toMatch(/^(day|visit)\.[a-z_]+: [A-Z]/);
    expect(readDayStatus('out')).toBe('out');
    expect(readDayStatus('gone')).toBeNull();
    expect(readDayStatus(7)).toBeNull();
  });
});

describe('what a rep lacks for a route', () => {
  it('names the modes the route needs that the rep does not do', () => {
    expect(modesLacking('both', ['van_sell', 'pre_sell'])).toEqual([]);
    expect(modesLacking('both', ['pre_sell'])).toEqual(['van sell']);
    expect(modesLacking('both', [])).toEqual(['van sell', 'pre-sell']);
    expect(modesLacking('pre_sell', ['van_sell'])).toEqual(['pre-sell']);
    expect(modesLacking('van_sell', ['van_sell'])).toEqual([]);
  });
});

describe('reading a request to plan a day', () => {
  const today = '2026-11-25';
  const plan = { routeId: id(1), date: '2026-11-30', repId: id(2), vanId: id(3) };
  it('takes a route, a date and, if wanted, a rep and a van', () => {
    expect(readPlan(plan, today)).toEqual({ ok: true, plan });
    expect(readPlan({ routeId: id(1), date: today }, today)).toEqual({ ok: true, plan: { routeId: id(1), date: today, repId: null, vanId: null } });
    expect(readPlan({ ...plan, repId: '', vanId: null }, today)).toMatchObject({ ok: true, plan: { repId: null, vanId: null } });
  });
  it.each([
    [null, 'could not be read'],
    [{ ...plan, routeId: 'x' }, 'route from the list'],
    [{ ...plan, date: '2026-02-30' }, 'real date'],
    [{ ...plan, date: undefined }, 'real date'],
    [{ ...plan, date: '2026-11-24' }, 'has passed'],
    [{ ...plan, repId: 'x' }, 'sales rep from the list'],
    [{ ...plan, vanId: 5 }, 'van from the list'],
  ])('refuses %j in words', (raw, words) => {
    const r = readPlan(raw, today);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(words);
  });
});
