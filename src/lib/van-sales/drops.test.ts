import { describe, expect, it } from 'vitest';
import { deliverProblem, dropAddProblem, dropNeeds, dropRemovable, readDropState, readDropStock, readReceivedBy, type DropFacts } from './drops';

const ok: DropFacts = { dayStatus: 'planned', vanAndOrders: true, order: { number: 'ORD-1', salesModule: 'sales_order', status: 'pending', approvalStatus: null, customerOnDay: true, deliveryMethod: null, alreadyOnADrop: false, hasLines: true, holdsStock: true } };
const withOrder = (o: Partial<DropFacts['order']>, over: Partial<DropFacts> = {}): DropFacts => ({ ...ok, ...over, order: { ...ok.order, ...o } });

describe('adding an order to a day\'s deliveries', () => {
  it('allows an open sales order of a customer on the day, before the day goes out', () => {
    expect(dropAddProblem(ok)).toBeNull();
    expect(dropAddProblem(withOrder({ deliveryMethod: 'own_fleet' }, { dayStatus: 'loading' }))).toBeNull();
  });
  it('refuses once the day is out, or on a day with no van or no orders', () => {
    expect(dropAddProblem(withOrder({}, { dayStatus: 'out' }))).toContain('before the day goes out');
    expect(dropAddProblem(withOrder({}, { vanAndOrders: false }))).toContain('with a van');
  });
  it('refuses an order that cannot be delivered from the van, and says why', () => {
    expect(dropAddProblem(withOrder({ salesModule: 'credit_sale' }))).toContain('not a sales order');
    expect(dropAddProblem(withOrder({ status: 'cancelled' }))).toContain('cancelled');
    expect(dropAddProblem(withOrder({ status: 'delivered' }))).toContain('closed');
    expect(dropAddProblem(withOrder({ approvalStatus: 'pending' }))).toContain('waiting for approval');
    expect(dropAddProblem(withOrder({ customerOnDay: false }))).toContain('not on this day\'s visits');
    expect(dropAddProblem(withOrder({ deliveryMethod: 'courier' }))).toContain('another way');
    expect(dropAddProblem(withOrder({ alreadyOnADrop: true }))).toContain('already on a delivery');
    expect(dropAddProblem(withOrder({ hasLines: false }))).toContain('nothing on it');
    expect(dropAddProblem(withOrder({ holdsStock: false }))).toContain('no longer holds stock');
  });
});

describe('what the deliveries need loaded', () => {
  it('adds up the lines per product', () => {
    expect(dropNeeds([{ productId: 'a', quantity: 2 }, { productId: 'b', quantity: 1 }, { productId: 'a', quantity: 3.5 }])).toEqual(new Map([['a', 5.5], ['b', 1]]));
    expect(dropNeeds([])).toEqual(new Map());
  });
});

describe('taking a delivery off the day', () => {
  it('is only while its stock is still at the warehouse', () => {
    expect(dropRemovable('planned', 'at_warehouse')).toBe(true);
    expect(dropRemovable('planned', 'on_the_way')).toBe(false);
    expect(dropRemovable('planned', 'on_van')).toBe(false);
    expect(dropRemovable('delivered', 'at_warehouse')).toBe(false);
  });
  it('reads stored words, falling back to the first state', () => {
    expect(readDropState('refused')).toBe('refused');
    expect(readDropState('x')).toBe('planned');
    expect(readDropStock('on_van')).toBe('on_van');
    expect(readDropStock('x')).toBe('at_warehouse');
  });
});


describe('delivering at the visit', () => {
  const base = { dayStatus: 'out', visitStatus: 'arrived', state: 'planned', stock: 'on_van', customerName: 'Duka', orderNumber: 'ORD-1' } as const;
  it('needs the day out, the rep at the customer and the stock on the van', () => {
    expect(deliverProblem(base)).toBeNull();
    expect(deliverProblem({ ...base, dayStatus: 'loading' })).toContain('while the day is out');
    expect(deliverProblem({ ...base, visitStatus: 'planned' })).toContain('Arrive at Duka');
    expect(deliverProblem({ ...base, state: 'delivered' })).toContain('already been dealt with');
    expect(deliverProblem({ ...base, stock: 'short' })).toContain('not on the van');
    expect(deliverProblem({ ...base, stock: 'short' }, false)).toBeNull();
  });
  it('reads who received the goods', () => {
    expect(readReceivedBy(' Mama Njeri ')).toEqual({ ok: true, name: 'Mama Njeri' });
    expect(readReceivedBy('x')).toEqual({ ok: false, error: 'Say who received the goods.' });
    expect(readReceivedBy(5)).toMatchObject({ ok: false });
    expect(readReceivedBy('a'.repeat(121))).toMatchObject({ ok: false });
  });
});
