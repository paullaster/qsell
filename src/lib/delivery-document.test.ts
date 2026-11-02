import { describe, expect, it } from 'vitest';
import {
  ACTION_WORDS,
  DELIVERY_ACTIONS,
  DELIVERY_STATUSES,
  STAGES_FOR,
  STATUS_WORDS,
  actionsFrom,
  allocate,
  checkPicked,
  isLive,
  isOver,
  nextStatus,
  openQuantities,
  orderDeliveryStatus,
  type DeliveryFacts,
  type DeliveryStatus,
} from './delivery-document';
import { isOrderStage } from './order-stages';

const line = (productId: string, quantity: number) => ({ productId, quantity });

describe('the states and what can be done from each', () => {
  it('walks an order from draft to delivered, one step at a time', () => {
    let status: DeliveryStatus = 'draft';
    for (const action of ['release', 'start_picking', 'record_picked', 'mark_packed', 'mark_ready', 'dispatch', 'deliver'] as const) {
      const next = nextStatus(status, action);
      expect(next, `${status} + ${action}`).not.toBeNull();
      status = next ?? status;
    }
    expect(status).toBe('delivered');
  });

  it('lets a failed attempt be tried again or returned, and nothing leaves a finished delivery', () => {
    expect(nextStatus('out_for_delivery', 'fail_attempt')).toBe('failed_attempt');
    expect(nextStatus('failed_attempt', 'reattempt')).toBe('ready');
    expect(nextStatus('failed_attempt', 'return')).toBe('returned');
    for (const done of ['delivered', 'returned', 'cancelled'] as const) {
      expect(isOver(done)).toBe(true);
      expect(actionsFrom(done)).toEqual([]);
    }
  });

  it('refuses a step out of order: no sending before it is packed, no delivering what was never sent', () => {
    expect(nextStatus('draft', 'dispatch')).toBeNull();
    expect(nextStatus('packed', 'deliver')).toBeNull();
    expect(nextStatus('ready', 'deliver')).toBeNull();
    expect(nextStatus('delivered', 'cancel')).toBeNull();
    expect(nextStatus('out_for_delivery', 'cancel')).toBeNull();
  });

  it('allows a delivery to be cancelled only before it goes out', () => {
    for (const early of ['draft', 'released', 'picking', 'packed', 'ready'] as const) expect(nextStatus(early, 'cancel')).toBe('cancelled');
  });

  it('keeps picking until it is packed, so a count can be corrected', () => {
    expect(nextStatus('picking', 'record_picked')).toBe('picking');
  });

  it('has words for every state and action, and puts only real stages on the order’s timeline', () => {
    for (const s of DELIVERY_STATUSES) expect(STATUS_WORDS[s].length).toBeGreaterThan(2);
    for (const a of DELIVERY_ACTIONS) {
      expect(ACTION_WORDS[a].length).toBeGreaterThan(2);
      for (const stage of STAGES_FOR[a]) expect(isOrderStage(stage), `${a} → ${stage}`).toBe(true);
    }
    expect(isOrderStage('part_delivered')).toBe(true);
  });

  it('counts a delivery against the order until it is cancelled or returned', () => {
    expect(isLive('draft')).toBe(true);
    expect(isLive('delivered')).toBe(true);
    expect(isLive('failed_attempt')).toBe(true);
    expect(isLive('cancelled')).toBe(false);
    expect(isLive('returned')).toBe(false);
  });
});

describe('what an order has left to deliver', () => {
  it('is what was ordered less what live deliveries carry, merged by product', () => {
    expect(openQuantities([line('a', 5), line('b', 2), line('a', 1)], [line('a', 4)])).toEqual([line('a', 2), line('b', 2)]);
    expect(openQuantities([line('a', 3)], [line('a', 3)])).toEqual([]);
  });

  it('works in the decimals a product is counted in', () => {
    expect(openQuantities([line('fish', 2.5)], [line('fish', 0.75)])).toEqual([line('fish', 1.75)]);
  });
});

describe('splitting an order into deliveries', () => {
  it('carries everything that is left when nothing is asked for', () => {
    expect(allocate([line('a', 3), line('b', 1)], [], null)).toEqual({ ok: true, lines: [line('a', 3), line('b', 1)] });
    expect(allocate([line('a', 3), line('b', 1)], [line('a', 3)], [])).toEqual({ ok: true, lines: [line('b', 1)] });
  });

  it('carries what is asked for, up to what is left of each product', () => {
    expect(allocate([line('a', 5)], [line('a', 2)], [line('a', 3)])).toEqual({ ok: true, lines: [line('a', 3)] });
    expect(allocate([line('a', 5)], [line('a', 2)], [line('a', 4)])).toMatchObject({ ok: false, error: expect.stringContaining('Only 3 is left') as string });
  });

  it('never carries more than the order, however many deliveries there are', () => {
    let committed: { productId: string; quantity: number }[] = [];
    for (let n = 0; n < 4; n += 1) {
      const made = allocate([line('a', 10)], committed, [line('a', 3)]);
      if (made.ok) committed = [...committed, ...made.lines];
    }
    expect(committed.reduce((t, l) => t + l.quantity, 0)).toBe(9);
  });

  it('refuses nothing to deliver, a product that is not on the order, a repeat, and quantities that are not positive', () => {
    expect(allocate([line('a', 1)], [line('a', 1)], null)).toMatchObject({ ok: false, error: expect.stringContaining('nothing left') as string });
    expect(allocate([line('a', 1)], [], [line('z', 1)])).toMatchObject({ ok: false });
    expect(allocate([line('a', 5)], [], [line('a', 1), line('a', 1)])).toMatchObject({ ok: false, error: expect.stringContaining('once') as string });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(allocate([line('a', 5)], [], [line('a', bad)]), String(bad)).toMatchObject({ ok: false });
  });
});

describe('what was picked against what was planned', () => {
  it('leaves a short pick open on the order, line by line', () => {
    const r = checkPicked([line('a', 5), line('b', 2)], [line('a', 3), line('b', 2)]);
    expect(r).toEqual({ ok: true, picked: [line('a', 3), line('b', 2)], short: [line('a', 2)] });
  });

  it('accepts a full pick with nothing short', () => {
    expect(checkPicked([line('a', 5)], [line('a', 5)])).toEqual({ ok: true, picked: [line('a', 5)], short: [] });
  });

  it('refuses more than planned, a missing answer, an unplanned product, a repeat, less than nothing, and a delivery with nothing picked at all', () => {
    expect(checkPicked([line('a', 2)], [line('a', 3)])).toMatchObject({ ok: false, error: expect.stringContaining('More was picked') as string });
    expect(checkPicked([line('a', 2), line('b', 1)], [line('a', 2)])).toMatchObject({ ok: false, error: expect.stringContaining('every product') as string });
    expect(checkPicked([line('a', 2)], [line('a', 2), line('z', 1)])).toMatchObject({ ok: false, error: expect.stringContaining('not on this delivery') as string });
    expect(checkPicked([line('a', 2)], [line('a', 1), line('a', 1)])).toMatchObject({ ok: false });
    expect(checkPicked([line('a', 2)], [line('a', -1)])).toMatchObject({ ok: false });
    expect(checkPicked([line('a', 2)], [line('a', 0)])).toMatchObject({ ok: false, error: expect.stringContaining('Nothing was picked') as string });
  });

  it('allows one line to be picked as none when another has something', () => {
    expect(checkPicked([line('a', 2), line('b', 1)], [line('a', 0), line('b', 1)])).toEqual({ ok: true, picked: [line('a', 0), line('b', 1)], short: [line('a', 2)] });
  });
});

describe('the order’s own delivery status', () => {
  const d = (status: DeliveryStatus, lines: DeliveryFacts['lines']): DeliveryFacts => ({ status, lines });
  const ordered = [line('a', 4), line('b', 2)];

  it('is not started with no delivery, and in progress once one is live', () => {
    expect(orderDeliveryStatus(ordered, []).state).toBe('not_started');
    expect(orderDeliveryStatus(ordered, [d('picking', [{ productId: 'a', quantity: 4, picked: null, delivered: 0 }])]).state).toBe('in_progress');
  });

  it('is partly delivered while some of the order is delivered and the rest is not', () => {
    const r = orderDeliveryStatus(ordered, [
      d('delivered', [{ productId: 'a', quantity: 4, picked: 4, delivered: 4 }]),
      d('ready', [{ productId: 'b', quantity: 2, picked: 2, delivered: 0 }]),
    ]);
    expect(r.state).toBe('partly_delivered');
    expect(r.lines).toEqual([
      { productId: 'a', ordered: 4, committed: 4, delivered: 4, open: 0 },
      { productId: 'b', ordered: 2, committed: 2, delivered: 0, open: 0 },
    ]);
  });

  it('is delivered only when every product is, across however many deliveries carried it', () => {
    const r = orderDeliveryStatus(ordered, [
      d('delivered', [{ productId: 'a', quantity: 2, picked: 2, delivered: 2 }]),
      d('delivered', [{ productId: 'a', quantity: 2, picked: 2, delivered: 2 }, { productId: 'b', quantity: 2, picked: 2, delivered: 2 }]),
    ]);
    expect(r.state).toBe('delivered');
  });

  it('counts a short pick as open again, and what was delivered is what was picked', () => {
    const r = orderDeliveryStatus([line('a', 5)], [d('delivered', [{ productId: 'a', quantity: 5, picked: 3, delivered: 3 }])]);
    expect(r.state).toBe('partly_delivered');
    expect(r.lines).toEqual([{ productId: 'a', ordered: 5, committed: 3, delivered: 3, open: 2 }]);
  });

  it('forgets a cancelled or returned delivery, so what it carried is open again', () => {
    const r = orderDeliveryStatus([line('a', 3)], [d('cancelled', [{ productId: 'a', quantity: 3, picked: null, delivered: 0 }]), d('returned', [{ productId: 'a', quantity: 3, picked: 3, delivered: 0 }])]);
    expect(r.state).toBe('not_started');
    expect(r.lines).toEqual([{ productId: 'a', ordered: 3, committed: 0, delivered: 0, open: 3 }]);
  });

  it('needs attention while an attempt has failed and nothing has been resolved', () => {
    expect(orderDeliveryStatus([line('a', 1)], [d('failed_attempt', [{ productId: 'a', quantity: 1, picked: 1, delivered: 0 }])]).state).toBe('exceptions');
  });

  it('is not started for an order with no lines', () => {
    expect(orderDeliveryStatus([], []).state).toBe('not_started');
  });
});
