import { describe, expect, it } from 'vitest';
import { allowedOptions, checkSellingInput, creditDaysFor, defOf, ENUM_SETTINGS, isSellingType, readSellingSettings, SELLING_TYPE_DEFS, SELLING_TYPES } from './selling-documents';

describe('the selling document types', () => {
  it('has a definition for every type, and every default is one of the choices the type offers', () => {
    expect(SELLING_TYPE_DEFS.map((d) => d.type).sort()).toEqual([...SELLING_TYPES].sort());
    for (const def of SELLING_TYPE_DEFS) for (const name of ENUM_SETTINGS) expect(allowedOptions(def.type, name)).toContain(def.defaults[name]);
  });

  it('gives each type the behaviour the design says: orders and credit sales check credit and hold over the limit; a sales invoice releases stock when issued; a cash sale has no credit', () => {
    expect(defOf('sales_order').defaults).toMatchObject({ creditCheck: 'limit', overLimit: 'hold', creditDays: 'customer', stockRelease: 'on_delivery', invoice: 'later' });
    expect(defOf('sales_invoice').defaults).toMatchObject({ creditCheck: 'limit', creditDays: 'customer', stockRelease: 'on_issue', invoice: 'with_document' });
    expect(defOf('credit_sale').defaults).toMatchObject({ noAccount: 'refuse', invoice: 'with_document' });
    expect(defOf('pos_cash_sale').defaults).toMatchObject({ creditCheck: 'off', approval: 'never', allowHoldUntilPaid: false });
    expect(allowedOptions('pos_cash_sale', 'creditCheck')).toEqual(['off']);
  });

  it('knows its own types', () => {
    expect(isSellingType('sales_invoice')).toBe(true);
    expect(isSellingType('ecommerce')).toBe(false);
  });
});

describe('what is stored', () => {
  it('falls back to the defaults for a missing, unreadable or not allowed value, and keeps a valid change', () => {
    const d = defOf('sales_order').defaults;
    expect(readSellingSettings('sales_order', null)).toEqual(d);
    expect(readSellingSettings('sales_order', 'x')).toEqual(d);
    const read = readSellingSettings('sales_order', { creditCheck: 'nonsense', stockRelease: 'on_payment', fixedDays: 90, overdueDays: -4, approval: 'never' });
    expect(read).toMatchObject({ creditCheck: d.creditCheck, stockRelease: 'on_payment', fixedDays: 90, overdueDays: d.overdueDays, approval: 'never' });
  });

  it('never lets a cash sale pick up credit from a stored row', () => {
    const read = readSellingSettings('pos_cash_sale', { creditCheck: 'limit', creditDays: 'customer', approval: 'workflow', allowHoldUntilPaid: true });
    expect(read).toMatchObject({ creditCheck: 'off', creditDays: 'on_issue', approval: 'never', allowHoldUntilPaid: false });
  });
});

describe('what the screen sends', () => {
  const full = (over: Record<string, unknown> = {}) => ({ ...defOf('sales_invoice').defaults, ...over });

  it('accepts the defaults and a valid change', () => {
    expect(checkSellingInput('sales_invoice', full()).ok).toBe(true);
    const changed = checkSellingInput('sales_invoice', full({ stockRelease: 'on_payment', creditCheck: 'limit_and_overdue', overdueDays: 14 }));
    expect(changed.ok && changed.settings).toMatchObject({ stockRelease: 'on_payment', creditCheck: 'limit_and_overdue', overdueDays: 14 });
  });

  it('refuses a choice the type does not offer, an unknown one and bad days, each in words', () => {
    expect(checkSellingInput('pos_cash_sale', { ...defOf('pos_cash_sale').defaults, creditCheck: 'limit' })).toEqual({ ok: false, error: 'Choose the credit check.' });
    expect(checkSellingInput('sales_order', full({ stockRelease: 'whenever' }))).toEqual({ ok: false, error: 'Choose when stock is released.' });
    expect(checkSellingInput('sales_order', full({ fixedDays: 400 })).ok).toBe(false);
    expect(checkSellingInput('sales_order', full({ overdueDays: 1.5 })).ok).toBe(false);
    expect(checkSellingInput('sales_order', null).ok).toBe(false);
    expect(checkSellingInput('pos_cash_sale', { ...defOf('pos_cash_sale').defaults, allowHoldUntilPaid: true })).toEqual({ ok: false, error: 'Cash sales cannot be held until paid.' });
  });

  it('does not keep "hold over the limit" for a document that never checks credit', () => {
    const r = checkSellingInput('sales_order', full({ creditCheck: 'off', overLimit: 'hold' }));
    expect(r.ok && r.settings.overLimit).toBe('refuse');
  });
});

describe('credit days', () => {
  it('follows the rule: the customer\'s terms, a fixed number, or none', () => {
    const s = defOf('sales_order').defaults;
    expect(creditDaysFor({ ...s, creditDays: 'customer' }, 30)).toBe(30);
    expect(creditDaysFor({ ...s, creditDays: 'fixed', fixedDays: 14 }, 30)).toBe(14);
    expect(creditDaysFor({ ...s, creditDays: 'on_issue' }, 30)).toBe(0);
    expect(creditDaysFor({ ...s, creditDays: 'customer' }, -5)).toBe(0);
  });
});
