import { describe, expect, it } from 'vitest';
import { allowedOptions, checkSellingInput, creditDaysFor, defOf, ENUM_SETTINGS, isSellingType, manualDiscountOffered, readSellingSettings, SELLING_TYPE_DEFS, SELLING_TYPES } from './selling-documents';

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
 
describe('the invoice after approval', () => {
  it('is automatic by default for every kind', () => {
    for (const def of SELLING_TYPE_DEFS) expect(def.defaults.invoiceAfterApproval).toBe(true);
  });

  it('is kept when it is turned off, falls back to automatic when a stored value is not a yes or no, and must be a yes or no from the screen', () => {
    expect(readSellingSettings('sales_invoice', { invoiceAfterApproval: false }).invoiceAfterApproval).toBe(false);
    expect(readSellingSettings('sales_invoice', { invoiceAfterApproval: 'no' }).invoiceAfterApproval).toBe(true);
    const full = { ...defOf('sales_invoice').defaults };
    expect(checkSellingInput('sales_invoice', { ...full, invoiceAfterApproval: false })).toMatchObject({ ok: true, settings: { invoiceAfterApproval: false } });
    expect(checkSellingInput('sales_invoice', { ...full, invoiceAfterApproval: undefined })).toEqual({ ok: false, error: 'Say whether the invoice is made automatically once the document is approved.' });
  });
});
});

describe('a discount staff type themselves', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const full = (over: Record<string, unknown>) => ({ ...defOf('pos_cash_sale').defaults, ...over });

  it('is off everywhere until the company turns it on, and only the counter can', () => {
    for (const def of SELLING_TYPE_DEFS) expect(def.defaults).toMatchObject({ manualDiscount: 'off', manualDiscountBranches: [] });
    expect(allowedOptions('pos_cash_sale', 'manualDiscount')).toEqual(['off', 'all_branches', 'selected_branches']);
    for (const type of ['sales_order', 'sales_invoice', 'credit_sale'] as const) expect(allowedOptions(type, 'manualDiscount')).toEqual(['off']);
  });

  it('is offered at every branch, only at the branches chosen, or nowhere, and never where discounts are not allowed', () => {
    const everywhere = readSellingSettings('pos_cash_sale', full({ manualDiscount: 'all_branches' }));
    expect(manualDiscountOffered(everywhere, A)).toBe(true);
    expect(manualDiscountOffered(everywhere, null)).toBe(true);
    const some = readSellingSettings('pos_cash_sale', full({ manualDiscount: 'selected_branches', manualDiscountBranches: [A] }));
    expect(manualDiscountOffered(some, A)).toBe(true);
    expect(manualDiscountOffered(some, A.toUpperCase())).toBe(true);
    expect(manualDiscountOffered(some, B)).toBe(false);
    expect(manualDiscountOffered(some, null)).toBe(false);
    expect(manualDiscountOffered(readSellingSettings('pos_cash_sale', full({ manualDiscount: 'off' })), A)).toBe(false);
    expect(manualDiscountOffered(readSellingSettings('pos_cash_sale', full({ manualDiscount: 'all_branches', discounts: 'not_allowed' })), A)).toBe(false);
  });

  it('keeps only real branch ids when read, and a type that cannot offer it reads as off', () => {
    expect(readSellingSettings('pos_cash_sale', full({ manualDiscount: 'selected_branches', manualDiscountBranches: [A, 'nope'] })).manualDiscountBranches).toEqual([]);
    expect(readSellingSettings('pos_cash_sale', full({ manualDiscount: 'selected_branches', manualDiscountBranches: [A, A.toUpperCase()] })).manualDiscountBranches).toEqual([A]);
    expect(readSellingSettings('sales_order', { manualDiscount: 'all_branches' }).manualDiscount).toBe('off');
  });

  it('is checked for real when saved: a known choice, branches that are ids, and at least one branch when only some are chosen', () => {
    const base = { ...defOf('pos_cash_sale').defaults };
    expect(checkSellingInput('pos_cash_sale', { ...base, manualDiscount: 'all_branches', manualDiscountBranches: [A] })).toMatchObject({ ok: true, settings: { manualDiscount: 'all_branches', manualDiscountBranches: [] } });
    expect(checkSellingInput('pos_cash_sale', { ...base, manualDiscount: 'selected_branches', manualDiscountBranches: [A, B] })).toMatchObject({ ok: true, settings: { manualDiscountBranches: [A, B] } });
    expect(checkSellingInput('pos_cash_sale', { ...base, manualDiscount: 'selected_branches', manualDiscountBranches: [] }).ok).toBe(false);
    expect(checkSellingInput('pos_cash_sale', { ...base, manualDiscount: 'selected_branches', manualDiscountBranches: ['x'] }).ok).toBe(false);
    expect(checkSellingInput('pos_cash_sale', { ...base, manualDiscount: 'sometimes' }).ok).toBe(false);
    expect(checkSellingInput('sales_order', { ...defOf('sales_order').defaults, manualDiscount: 'all_branches' }).ok).toBe(false);
  });
});
