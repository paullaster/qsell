import { describe, expect, it } from 'vitest';
import { STOCK_MOVEMENT_TYPES, checkLocation, isMovementType, movementTypeOfJournal, NON_PHYSICAL_JOURNAL_TYPES } from './stock';

const good = { code: 'MAIN', name: 'Main stock', kind: 'warehouse' };

describe('the journal to the ledger', () => {
  it.each([
    ['order_fulfillment', 'sale_issue'],
    ['purchase_order_receipt', 'receipt'],
    ['restock', 'receipt'],
    ['purchase_receipt_reversal', 'receipt_reversal'],
    ['purchase_return', 'purchase_return'],
    ['credit_note_restock', 'sale_return'],
    ['manual_adjustment', 'adjustment'],
    ['physical_audit', 'count_variance'],
    ['damage_writeoff', 'write_off'],
    ['product_deleted', 'delete_adjust'],
    ['product_restored', 'delete_adjust'],
    ['something_new', 'adjustment'],
  ])('%s is a %s', (journal, kind) => {
    expect(movementTypeOfJournal(journal)).toBe(kind);
  });
  it('leaves holds and cost changes out, they are not physical stock', () => {
    for (const t of NON_PHYSICAL_JOURNAL_TYPES) expect(movementTypeOfJournal(t), t).toBeNull();
  });
  it('only ever answers a type the ledger knows', () => {
    for (const t of ['order_fulfillment', 'restock', 'x']) expect(isMovementType(movementTypeOfJournal(t))).toBe(true);
    expect(isMovementType('made_up')).toBe(false);
    expect(new Set(STOCK_MOVEMENT_TYPES).size).toBe(STOCK_MOVEMENT_TYPES.length);
  });
});

describe('checkLocation', () => {
  it('accepts a plain location and fills in the defaults', () => {
    expect(checkLocation(good)).toEqual({
      ok: true,
      location: { code: 'MAIN', name: 'Main stock', kind: 'warehouse', branchId: null, address: '', isSellable: true, sellsChannels: ['ecommerce', 'sales_order', 'credit_sale', 'pos_cash_sale'], fulfilsDelivery: true, allowNegative: false },
    });
  });
  it('trims, and keeps each channel once', () => {
    const r = checkLocation({ ...good, code: ' VAN-1 ', name: '  Van one ', kind: 'van', sellsChannels: ['sales_order', 'sales_order'] });
    expect(r).toMatchObject({ ok: true, location: { code: 'VAN-1', name: 'Van one', sellsChannels: ['sales_order'] } });
  });
  it.each([
    [{ code: '' }, 'code'],
    [{ code: '-x' }, 'code'],
    [{ code: 'A'.repeat(21) }, 'code'],
    [{ code: 'has space' }, 'code'],
    [{ name: '  ' }, 'name'],
    [{ name: 'n'.repeat(121) }, 'name'],
    [{ kind: 'shed' }, 'kind'],
    [{ branchId: 'not-a-uuid' }, 'branch'],
    [{ address: 'a'.repeat(301) }, 'address'],
    [{ sellsChannels: ['ecommerce', 'barter'] }, 'channel'],
    [{ sellsChannels: 'ecommerce' }, 'channel'],
    [{ isSellable: 'yes' }, 'sold'],
    [{ allowNegative: 1 }, 'on or off'],
  ])('refuses %j (%s)', (over, word) => {
    const r = checkLocation({ ...good, ...over });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toContain(word);
  });
  it.each(['quarantine', 'damaged', 'transit'])('does not let a %s location be sold from', (kind) => {
    expect(checkLocation({ ...good, kind }).ok).toBe(false);
    expect(checkLocation({ ...good, kind, isSellable: false }).ok).toBe(true);
  });
});
