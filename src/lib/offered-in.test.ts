import { describe, expect, it } from 'vitest';
import { isOfferedIn, notOfferedRefusal, offerTypeOfModule, readOfferedIn } from './offered-in';

describe('where a product is offered', () => {
  it('is offered everywhere unless a list says otherwise', () => {
    expect(isOfferedIn(undefined, 'pos_cash_sale')).toBe(true);
    expect(isOfferedIn(null, 'quote')).toBe(true);
    expect(isOfferedIn(['quote', 'sales_order'], 'quote')).toBe(true);
    expect(isOfferedIn(['quote', 'sales_order'], 'pos_cash_sale')).toBe(false);
    expect(isOfferedIn([], 'quote')).toBe(false);
  });
  it('tells the person which document and what to change', () => {
    expect(notOfferedRefusal('Lunch', 'pos_cash_sale')).toBe('Lunch is not offered in cash sales (the counter). Change where it is offered on the product.');
  });
  it('reads a list from a screen: known types only, each once, in the usual order', () => {
    expect(readOfferedIn(['sales_order', 'quote', 'quote'])).toEqual({ ok: true, value: ['quote', 'sales_order'] });
    expect(readOfferedIn([])).toEqual({ ok: true, value: [] });
    expect(readOfferedIn(['quote', 'ecommerce']).ok).toBe(false);
    expect(readOfferedIn('quote').ok).toBe(false);
    expect(readOfferedIn(null).ok).toBe(false);
  });
  it('names the document an order is, and leaves the web shop to its own switch', () => {
    expect(offerTypeOfModule('pos_cash_sale', false)).toBe('pos_cash_sale');
    expect(offerTypeOfModule('sales_order', true)).toBe('credit_sale');
    expect(offerTypeOfModule('credit_sale', false)).toBe('credit_sale');
    expect(offerTypeOfModule('ecommerce', false)).toBeNull();
    expect(offerTypeOfModule(undefined, false)).toBeNull();
  });
});
