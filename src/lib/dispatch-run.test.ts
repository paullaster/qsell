import { describe, expect, it } from 'vitest';
import { canJoinRun, isReordering, isRunEditable, moveStop, nearestNext, nextRunStatus, runActionsFrom, runCloseProblem, runTotals, waitingSince } from './dispatch-run';

const p = (latitude: number, longitude: number) => ({ latitude, longitude });

describe('the states of a run', () => {
  it('goes planned, started, completed, and can be cancelled only before it starts', () => {
    expect(nextRunStatus('planned', 'start')).toBe('started');
    expect(nextRunStatus('started', 'complete')).toBe('completed');
    expect(nextRunStatus('planned', 'cancel')).toBe('cancelled');
    expect(nextRunStatus('started', 'cancel')).toBeNull();
    expect(nextRunStatus('planned', 'complete')).toBeNull();
    expect(nextRunStatus('completed', 'start')).toBeNull();
    expect(runActionsFrom('planned')).toEqual(['start', 'cancel']);
    expect(runActionsFrom('started')).toEqual(['complete']);
    expect(runActionsFrom('cancelled')).toEqual([]);
  });
  it('is edited only while planned', () => {
    expect(isRunEditable('planned')).toBe(true);
    expect(['started', 'completed', 'cancelled'].some((s) => isRunEditable(s as 'started'))).toBe(false);
  });
  it('takes only a delivery that is ready and not already on a run', () => {
    expect(canJoinRun('ready', false)).toBe(true);
    expect(canJoinRun('ready', true)).toBe(false);
    expect(canJoinRun('packed', false)).toBe(false);
    expect(canJoinRun('out_for_delivery', false)).toBe(false);
  });
  it('cannot be closed while a delivery is still out, and says how many', () => {
    expect(runCloseProblem([{ deliveryStatus: 'delivered' }, { deliveryStatus: 'failed_attempt' }])).toBeNull();
    expect(runCloseProblem([{ deliveryStatus: 'out_for_delivery' }])).toMatch(/1 delivery is still out/);
    expect(runCloseProblem([{ deliveryStatus: 'out_for_delivery' }, { deliveryStatus: 'out_for_delivery' }])).toMatch(/2 deliveries are still out/);
  });
});

describe('the suggested order of stops', () => {
  it('goes to the nearest next from the start, and puts stops without a pin last in the order given', () => {
    const start = p(-1.2864, 36.8172);
    const near = { id: 'near', point: p(-1.2900, 36.8200) };
    const mid = { id: 'mid', point: p(-1.3200, 36.8500) };
    const far = { id: 'far', point: p(-1.4000, 36.9500) };
    expect(nearestNext(start, [far, near, mid])).toEqual(['near', 'mid', 'far']);
    expect(nearestNext(start, [{ id: 'x', point: null }, far, { id: 'y', point: null }, near])).toEqual(['near', 'far', 'x', 'y']);
  });
  it('starts from the first stop when there is no start, and copes with nothing', () => {
    expect(nearestNext(null, [{ id: 'a', point: p(0, 0) }, { id: 'b', point: p(0, 1) }])).toEqual(['a', 'b']);
    expect(nearestNext(null, [])).toEqual([]);
    expect(nearestNext(p(0, 0), [{ id: 'only', point: null }])).toEqual(['only']);
  });
  it('moves a stop up or down by one, and refuses a move off either end', () => {
    expect(moveStop(['a', 'b', 'c'], 'b', 'up')).toEqual(['b', 'a', 'c']);
    expect(moveStop(['a', 'b', 'c'], 'b', 'down')).toEqual(['a', 'c', 'b']);
    expect(moveStop(['a', 'b', 'c'], 'a', 'up')).toBeNull();
    expect(moveStop(['a', 'b', 'c'], 'c', 'down')).toBeNull();
    expect(moveStop(['a', 'b'], 'z', 'up')).toBeNull();
  });
  it('knows a true reordering from one that adds, drops or repeats a stop', () => {
    expect(isReordering(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe(true);
    expect(isReordering(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
    expect(isReordering(['a', 'b', 'c'], ['a', 'b', 'b'])).toBe(false);
    expect(isReordering(['a', 'b', 'c'], ['a', 'b', 'z'])).toBe(false);
  });
});

describe('a run in numbers', () => {
  it('adds stops, units, value and the weight of what has one, and counts the stops with none', () => {
    expect(runTotals([{ units: 2, value: 1500.5, weightKg: 1.5 }, { units: 3, value: 200.25, weightKg: null }, { units: 1, value: 10, weightKg: 0.25 }])).toEqual({ stops: 3, units: 6, value: 1710.75, weightKg: 1.75, stopsWithoutWeight: 1 });
    expect(runTotals([])).toEqual({ stops: 0, units: 0, value: 0, weightKg: null, stopsWithoutWeight: 0 });
    expect(runTotals([{ units: 1, value: 1, weightKg: null }]).weightKg).toBeNull();
  });
  it('flags a delivery that has waited a day, with the clock passed in', () => {
    const now = new Date('2026-11-04T12:00:00Z');
    expect(waitingSince(null, now)).toBeNull();
    expect(waitingSince(new Date('2026-11-04T09:30:00Z'), now)).toEqual({ hours: 2, late: false });
    expect(waitingSince(new Date('2026-11-03T12:00:00Z'), now)).toEqual({ hours: 24, late: true });
    expect(waitingSince(new Date('2026-11-05T12:00:00Z'), now)).toEqual({ hours: 0, late: false });
  });
});
