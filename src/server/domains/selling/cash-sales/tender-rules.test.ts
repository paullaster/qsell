import { describe, expect, it } from 'vitest';
import { cashTaken, planTenders, type TenderRequest } from './tender-rules';

const cash = (amount: number): TenderRequest => ({ methodId: 'cash-m', kind: 'cash', amount, reference: null });
const mpesa = (amount: number, reference: string | null = 'QWE123'): TenderRequest => ({ methodId: 'mpesa-m', kind: 'mobile_money', amount, reference });
const card = (amount: number): TenderRequest => ({ methodId: 'card-m', kind: 'card', amount, reference: '0042' });

describe('paying a counter sale', () => {
  it('gives change when more cash is handed over than the sale', () => {
    const plan = planTenders(1450, [cash(2000)]);
    expect(plan).toMatchObject({ ok: true, changeDue: 550, total: 1450 });
    expect(plan.ok ? plan.tenders : []).toEqual([{ methodId: 'cash-m', kind: 'cash', applied: 1450, handedOver: 2000, changeDue: 550, reference: null }]);
  });
  it('takes exact cash with no change', () => {
    expect(planTenders(1450, [cash(1450)])).toMatchObject({ ok: true, changeDue: 0 });
  });
  it('refuses cash that is short, saying by how much', () => {
    expect(planTenders(1450, [cash(1400)])).toEqual({ ok: false, error: 'The cash is short: 50.00 more is needed.' });
  });
  it('takes M-Pesa or card exactly, and never gives change from them', () => {
    expect(planTenders(1450, [mpesa(1450)])).toMatchObject({ ok: true, changeDue: 0 });
    expect(planTenders(1450, [card(1450)])).toMatchObject({ ok: true, changeDue: 0 });
    expect(planTenders(1450, [mpesa(1500)])).toEqual({ ok: false, error: 'M-Pesa and card cannot be more than the sale: they cannot give change.' });
    expect(planTenders(1450, [mpesa(1000)])).toEqual({ ok: false, error: 'The sale is KES 1450.00 and 1000.00 was paid: 450.00 is still to pay.' });
  });
  it('splits a sale: the exact ways first, the cash covers the rest and change is worked from that', () => {
    const plan = planTenders(1450, [mpesa(1000), cash(500)]);
    expect(plan).toMatchObject({ ok: true, changeDue: 50 });
    expect(plan.ok ? plan.tenders.map((t) => [t.kind, t.applied, t.changeDue]) : []).toEqual([['mobile_money', 1000, null], ['cash', 450, 50]]);
    expect(planTenders(1450, [mpesa(1000), card(450)])).toMatchObject({ ok: true, changeDue: 0 });
  });
  it('refuses cash that is not needed because the other ways already cover the sale', () => {
    expect(planTenders(1000, [mpesa(1000), cash(100)])).toEqual({ ok: false, error: 'The other ways of paying already cover the sale: take the cash off.' });
  });
  it('refuses a way of paying used twice, too many ways, and amounts that are not money', () => {
    expect(planTenders(1000, [mpesa(500), mpesa(500)]).ok).toBe(false);
    expect(planTenders(1000, [cash(500), { ...cash(500), methodId: 'cash-2' }]).ok).toBe(false);
    expect(planTenders(1000, [mpesa(1), card(1), { ...mpesa(1), methodId: 'm3' }, { ...card(1), methodId: 'c4' }, cash(1000)]).ok).toBe(false);
    expect(planTenders(1000, [cash(0)]).ok).toBe(false);
    expect(planTenders(1000, [cash(-5)]).ok).toBe(false);
    expect(planTenders(1000, [cash(1000.005)]).ok).toBe(false);
    expect(planTenders(1000, [cash(Number.NaN)]).ok).toBe(false);
    expect(planTenders(1000, []).ok).toBe(false);
    expect(planTenders(0, [cash(10)]).ok).toBe(false);
  });
  it('does not drift on amounts like 0.1 + 0.2', () => {
    expect(planTenders(0.3, [mpesa(0.1), card(0.2)])).toMatchObject({ ok: true, changeDue: 0 });
    expect(planTenders(10.1, [cash(20)])).toMatchObject({ ok: true, changeDue: 9.9 });
  });
  it('counts only the cash a sale took toward the till', () => {
    expect(cashTaken([{ kind: 'cash', applied: 450 }, { kind: 'mobile_money', applied: 1000 }])).toBe(450);
    expect(cashTaken([{ kind: 'card', applied: 1000 }])).toBe(0);
  });
});
