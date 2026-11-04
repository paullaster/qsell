import { describe, expect, it } from 'vitest';
import { checkAcceptance, checkRescheduleDay, isNotAcceptedReason } from './delivery-acceptance';

const carried = [{ productId: 'a', quantity: 4 }, { productId: 'b', quantity: 2 }];

describe('partial acceptance', () => {
  it('takes everything when nothing is given', () => {
    expect(checkAcceptance(carried, null)).toEqual({ ok: true, accepted: carried, notAccepted: [], whole: true });
    expect(checkAcceptance(carried, [])).toMatchObject({ ok: true, whole: true });
  });

  it('records what was not taken, with its reason', () => {
    const r = checkAcceptance(carried, [{ productId: 'a', quantity: 3, reasonCode: 'damaged' }, { productId: 'b', quantity: 2 }]);
    expect(r).toEqual({ ok: true, accepted: [{ productId: 'a', quantity: 3 }, { productId: 'b', quantity: 2 }], notAccepted: [{ productId: 'a', quantity: 1, reasonCode: 'damaged', note: null }], whole: false });
  });

  it('needs every line answered, no more than carried, and a reason for a shortfall', () => {
    expect(checkAcceptance(carried, [{ productId: 'a', quantity: 4 }])).toMatchObject({ ok: false });
    expect(checkAcceptance(carried, [{ productId: 'a', quantity: 5 }, { productId: 'b', quantity: 2 }])).toMatchObject({ ok: false });
    expect(checkAcceptance(carried, [{ productId: 'a', quantity: -1 }, { productId: 'b', quantity: 2 }])).toMatchObject({ ok: false });
    expect(checkAcceptance(carried, [{ productId: 'a', quantity: 2 }, { productId: 'b', quantity: 2 }])).toMatchObject({ ok: false, error: 'Say why some of it was not taken.' });
    expect(checkAcceptance(carried, [{ productId: 'a', quantity: 2, reasonCode: 'other' }, { productId: 'b', quantity: 2 }])).toMatchObject({ ok: false });
    expect(checkAcceptance(carried, [{ productId: 'a', quantity: 2, reasonCode: 'other', note: 'Box crushed' }, { productId: 'b', quantity: 2 }])).toMatchObject({ ok: true });
    expect(checkAcceptance(carried, [{ productId: 'a', quantity: 4 }, { productId: 'a', quantity: 4 }, { productId: 'b', quantity: 2 }])).toMatchObject({ ok: false });
    expect(checkAcceptance(carried, [{ productId: 'z', quantity: 1 }, { productId: 'a', quantity: 4 }, { productId: 'b', quantity: 2 }])).toMatchObject({ ok: false });
  });

  it('is not a delivery when nothing was taken', () => {
    expect(checkAcceptance(carried, [{ productId: 'a', quantity: 0, reasonCode: 'refused' }, { productId: 'b', quantity: 0, reasonCode: 'refused' }])).toMatchObject({ ok: false });
  });

  it('knows the reasons', () => {
    expect(isNotAcceptedReason('wrong_item')).toBe(true);
    expect(isNotAcceptedReason('customer_absent')).toBe(false);
  });
});

describe('a new day for a delivery', () => {
  it('is after today and within two weeks', () => {
    expect(checkRescheduleDay('2026-11-05', '2026-11-04')).toEqual({ ok: true, date: '2026-11-05' });
    expect(checkRescheduleDay('2026-11-18', '2026-11-04')).toEqual({ ok: true, date: '2026-11-18' });
    expect(checkRescheduleDay('2026-11-04', '2026-11-04')).toMatchObject({ ok: false });
    expect(checkRescheduleDay('2026-11-19', '2026-11-04')).toMatchObject({ ok: false });
    expect(checkRescheduleDay('2026-02-30', '2026-02-01')).toMatchObject({ ok: false });
    expect(checkRescheduleDay('tomorrow', '2026-11-04')).toMatchObject({ ok: false });
    expect(checkRescheduleDay(null, '2026-11-04')).toMatchObject({ ok: false });
  });
});
