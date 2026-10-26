import { describe, expect, it } from 'vitest';
import { changeLabel, planChange, purposeName, readinessChecks, stockValueCents } from './inventory-posting';

const move = (changeType: string, valueCents: number) => planChange({ kind: 'movement', changeType, valueCents });

describe('where a change in stock goes', () => {
  it('takes goods returned to a vendor out of stock against the clearing account, like a reversed receipt', () => {
    expect(move('purchase_return', -4000)).toMatchObject({ debit: 'inventory_clearing', credit: 'inventory', cents: 4000, label: 'Goods returned to the vendor' });
  });
  it('goods received build stock up against stock received but not invoiced', () => {
    for (const t of ['purchase_order_receipt', 'restock', 'product_restored']) expect(move(t, 120000)).toMatchObject({ debit: 'inventory', credit: 'inventory_clearing', cents: 120000 });
  });

  it('goods sold are cost of sales, and goods back from a customer undo it', () => {
    expect(move('order_fulfillment', -30000)).toMatchObject({ debit: 'cogs', credit: 'inventory', cents: 30000, label: 'Goods sold' });
    expect(move('credit_note_restock', 30000)).toMatchObject({ debit: 'inventory', credit: 'cogs', cents: 30000 });
  });

  it('counts, write-offs and anything unknown go through the adjustment account, in either direction', () => {
    expect(move('physical_audit', 500)).toMatchObject({ debit: 'inventory', credit: 'inventory_adjustment' });
    expect(move('damage_writeoff', -500)).toMatchObject({ debit: 'inventory_adjustment', credit: 'inventory' });
    expect(move('something_new', -500)).toMatchObject({ debit: 'inventory_adjustment', credit: 'inventory', label: 'Stock changed' });
    expect(move('something_new', 500)).toMatchObject({ debit: 'inventory', credit: 'inventory_adjustment' });
  });

  it('a change of cost raises or lowers the value of what is on the shelf', () => {
    expect(planChange({ kind: 'revaluation', changeType: 'cost_change', valueCents: 700 })).toMatchObject({ debit: 'inventory', credit: 'inventory_adjustment', cents: 700 });
    expect(planChange({ kind: 'revaluation', changeType: 'cost_change', valueCents: -700 })).toMatchObject({ debit: 'inventory_adjustment', credit: 'inventory', cents: 700 });
  });

  it('has nothing to post for goods worth nothing', () => {
    expect(move('order_fulfillment', 0)).toBeNull();
    expect(planChange({ kind: 'revaluation', changeType: 'cost_change', valueCents: 0 })).toBeNull();
  });

  it('names changes in words', () => {
    expect(changeLabel('credit_note_restock')).toBe('Goods back from a customer');
    expect(changeLabel('nope')).toBe('Stock changed');
    expect(purposeName('inventory_clearing')).toBe('Stock received, not yet invoiced');
    expect(purposeName('x')).toBe('x');
  });
});

describe('the value of stock', () => {
  it('is units times cost, to the cent, never rounded', () => {
    expect(stockValueCents(3, '300.00')).toBe(90000);
    expect(stockValueCents(-2, '12.34')).toBe(-2468);
    expect(stockValueCents(7, '0.05')).toBe(35);
    expect(stockValueCents(5, '10')).toBe(5000);
    // A fraction of a unit: the money is rounded to the cent, half away from zero.
    expect(stockValueCents(0.125, '33.33')).toBe(417);
    expect(stockValueCents(-2.5, '33.33')).toBe(-8333);
    expect(stockValueCents(1.5, '0.01')).toBe(2);
    expect(stockValueCents(0, '99.99')).toBe(0);
  });
});

describe('reversing a receipt', () => {
  it('clears what the receipt put in the clearing account, not the adjustment account', () => {
    expect(move('purchase_receipt_reversal', -120000)).toMatchObject({ debit: 'inventory_clearing', credit: 'inventory', cents: 120000 });
    expect(move('manual_adjustment', -120000)).toMatchObject({ debit: 'inventory_adjustment', credit: 'inventory' });
  });
});

describe('readiness', () => {
  it('blocks until finance is set up and every account is chosen, then only informs', () => {
    const blocked = readinessChecks({ financeSetUp: false, missing: ['inventory', 'cogs'], live: false, failed: 0 });
    expect(blocked.filter((c) => c.blocking && !c.ok).map((c) => c.key)).toEqual(['finance', 'inventory', 'cogs']);
    const ready = readinessChecks({ financeSetUp: true, missing: [], live: true, failed: 2 });
    expect(ready.filter((c) => c.blocking && !c.ok)).toEqual([]);
    expect(ready.find((c) => c.key === 'failed')).toMatchObject({ ok: false, blocking: false });
    expect(ready.find((c) => c.key === 'failed')?.detail).toContain('2 changes');
  });
});
