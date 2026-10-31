import { describe, expect, it } from 'vitest';
import {
  COUNT_STATES,
  COUNT_STATE_WORDS,
  TRANSFER_STATES,
  TRANSFER_STATE_WORDS,
  canCountMove,
  canTransferMove,
  checkCountEntries,
  checkTransferLines,
  countNeedsApproval,
  countVariance,
  inTransit,
  stateAfterMovement,
  varianceValue,
} from './stock-documents';

describe('transfer states', () => {
  it('only move forward along the permitted steps', () => {
    expect(canTransferMove('draft', 'requested')).toBe(true);
    expect(canTransferMove('requested', 'shipped')).toBe(true);
    expect(canTransferMove('requested', 'approved')).toBe(true);
    expect(canTransferMove('shipped', 'partly_received')).toBe(true);
    expect(canTransferMove('partly_received', 'partly_received')).toBe(true);
    expect(canTransferMove('draft', 'shipped')).toBe(false);
    expect(canTransferMove('shipped', 'cancelled')).toBe(false);
    expect(canTransferMove('received', 'shipped')).toBe(false);
  });
  it('end where they end: nothing leaves a finished transfer', () => {
    for (const end of ['received', 'closed', 'cancelled'] as const) for (const to of TRANSFER_STATES) expect(canTransferMove(end, to), `${end} → ${to}`).toBe(false);
  });
});

describe('count states', () => {
  it('go counting, counted, (approved), posted, and can be sent back to counting before posting', () => {
    expect(canCountMove('counting', 'counted')).toBe(true);
    expect(canCountMove('counted', 'posted')).toBe(true);
    expect(canCountMove('counted', 'approved')).toBe(true);
    expect(canCountMove('counted', 'counting')).toBe(true);
    expect(canCountMove('approved', 'posted')).toBe(true);
    expect(canCountMove('posted', 'counting')).toBe(false);
    expect(canCountMove('counting', 'posted')).toBe(false);
    for (const to of COUNT_STATES) expect(canCountMove('cancelled', to)).toBe(false);
  });
});

describe('what is on its way', () => {
  const line = (shipped: number, received = 0, writtenOff = 0, returned = 0) => ({ shipped, received, writtenOff, returned });
  it('is shipped less everything accounted for', () => {
    expect(inTransit(line(10, 4, 1, 2))).toBe(3);
    expect(inTransit(line(0.3, 0.1, 0.2))).toBe(0);
  });
  it('decides the state from the lines', () => {
    expect(stateAfterMovement([line(5), line(3)])).toBe('shipped');
    expect(stateAfterMovement([line(5, 2), line(3)])).toBe('partly_received');
    expect(stateAfterMovement([line(5, 5), line(3, 3)])).toBe('received');
    expect(stateAfterMovement([line(5, 4, 1), line(3, 3)])).toBe('closed');
    expect(stateAfterMovement([line(5, 3, 0, 2)])).toBe('closed');
  });
});

describe('checkTransferLines', () => {
  it('accepts good lines and rounds to thousandths', () => {
    expect(checkTransferLines([{ productId: ' p1 ', quantity: 2 }, { productId: 'p2', quantity: 0.125 }])).toEqual({ ok: true, lines: [{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 0.125 }] });
  });
  it.each([
    [[], 'at least one'],
    ['x', 'at least one'],
    [[{ productId: '', quantity: 1 }], 'product'],
    [[{ productId: 'a', quantity: 1 }, { productId: 'a', quantity: 2 }], 'only once'],
    [[{ productId: 'a', quantity: 0 }], 'more than zero'],
    [[{ productId: 'a', quantity: -1 }], 'more than zero'],
    [[{ productId: 'a', quantity: '1' }], 'more than zero'],
    [[{ productId: 'a', quantity: Number.NaN }], 'more than zero'],
    [[{ productId: 'a', quantity: 1.0004 }], 'three decimals'],
    [[null], 'product'],
  ])('refuses %j (%s)', (input, word) => {
    const r = checkTransferLines(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(word);
  });
  it('refuses too many lines', () => {
    expect(checkTransferLines(Array.from({ length: 501 }, (_x, i) => ({ productId: `p${String(i)}`, quantity: 1 }))).ok).toBe(false);
  });
});

describe('checkCountEntries', () => {
  it('lets a counted quantity be zero', () => {
    expect(checkCountEntries([{ productId: 'a', quantity: 0 }])).toEqual({ ok: true, lines: [{ productId: 'a', quantity: 0 }] });
  });
  it.each([
    [[{ productId: 'a', quantity: -1 }], 'zero or more'],
    [[{ productId: 'a', quantity: 1 }, { productId: 'a', quantity: 2 }], 'once per entry'],
    [[{ productId: 'a', quantity: 1.0001 }], 'three decimals'],
    [[], 'at least one'],
  ])('refuses %j', (input, word) => {
    const r = checkCountEntries(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(word);
  });
});

describe('a count’s variance', () => {
  it('is what was found less what should have been there', () => {
    expect(countVariance(10, 0, 8)).toBe(-2);
    expect(countVariance(10, 0, 12)).toBe(2);
    expect(countVariance(10, 0, 10)).toBe(0);
  });
  it('takes stock that moved since the snapshot into account, so counting needs no freeze', () => {
    // 10 on the shelf at the snapshot, 3 sold before the shelf was counted: 7 is right, not a loss of 3.
    expect(countVariance(10, -3, 7)).toBe(0);
    expect(countVariance(10, -3, 6)).toBe(-1);
    expect(countVariance(0.1, 0.2, 0.3)).toBe(0);
  });
  it('values the differences in either direction, and asks for a second person only above the limit', () => {
    const v = varianceValue([{ variance: -2, unitCost: 10 }, { variance: 3, unitCost: 5.5 }]);
    expect(v).toBe(36.5);
    expect(countNeedsApproval(v, 0)).toBe(false);
    expect(countNeedsApproval(v, 36.5)).toBe(false);
    expect(countNeedsApproval(v, 36.49)).toBe(true);
  });
});

describe('the words for states', () => {
  it('say something plain for every state there is', () => {
    for (const s of TRANSFER_STATES) expect(TRANSFER_STATE_WORDS[s].label.length, s).toBeGreaterThan(3);
    for (const s of COUNT_STATES) expect(COUNT_STATE_WORDS[s].label.length, s).toBeGreaterThan(3);
  });
});
