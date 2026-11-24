import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { conversionChoices, conversionKey, isQuoteTarget, quoteBlock, type ConversionFacts, type KindSettings } from './quote-conversion';

const kind: KindSettings = { stockRelease: 'on_delivery', approval: 'workflow', invoice: 'later', creditCheck: 'limit', overLimit: 'hold', creditDays: 'customer', fixedDays: 30 };
const facts = (over: Partial<ConversionFacts> = {}): ConversionFacts => ({
  quoteNumber: 'QTE-1',
  status: 'accepted',
  expired: false,
  convertedTo: null,
  addressComplete: true,
  total: 1000,
  currency: 'KES',
  deliveryFee: 0,
  customer: { name: 'Acme', hasCreditAccount: true, blocked: false, creditLimit: 5000, available: 4000, termDays: 30, overdue: false },
  settings: { sales_order: kind, sales_invoice: { ...kind, invoice: 'with_document' }, credit_sale: kind, cash_sale: { ...kind, stockRelease: 'on_issue' } },
  can: { sales_order: true, sales_invoice: true, credit_sale: true, cash_sale: true },
  canApprove: true,
  shiftOpen: true,
  ...over,
});
const by = (f: ConversionFacts, target: string) => {
  const found = conversionChoices(f).find((c) => c.target === target);
  if (found === undefined) throw new Error(`no choice ${target}`);
  return found;
};

describe('what a quote can become', () => {
  it('offers all four for an accepted quote to a credit customer with a shift open', () => {
    expect(conversionChoices(facts()).map((c) => [c.target, c.available])).toEqual([['sales_order', true], ['sales_invoice', true], ['credit_sale', true], ['cash_sale', true]]);
  });

  it('can also be converted while it is only sent: the staff accept for the customer', () => {
    expect(quoteBlock(facts({ status: 'sent' }))).toBeNull();
    expect(quoteBlock(facts({ status: 'draft' }))).toMatch(/Send the quote/);
    expect(quoteBlock(facts({ status: 'pending_approval' }))).toMatch(/Send the quote/);
  });

  it('says why nothing can be chosen once it has become something, expired, been rejected or cancelled', () => {
    expect(quoteBlock(facts({ convertedTo: { label: 'Sales invoice', number: 'INV-9' } }))).toBe('This quote already became sales invoice INV-9.');
    expect(quoteBlock(facts({ expired: true }))).toMatch(/expired/);
    expect(quoteBlock(facts({ status: 'rejected' }))).toMatch(/rejected/);
    expect(quoteBlock(facts({ status: 'cancelled' }))).toMatch(/cancelled/);
    expect(conversionChoices(facts({ status: 'cancelled' })).every((c) => !c.available)).toBe(true);
    expect(quoteBlock(facts({ canApprove: false }))).toMatch(/permission/);
  });

  it('keeps a credit sale for a customer with a credit account', () => {
    const c = by(facts({ customer: { name: 'Jane', hasCreditAccount: false, blocked: false, creditLimit: 0, available: 0, termDays: 0, overdue: false } }), 'credit_sale');
    expect(c.available).toBe(false);
    expect(c.reason).toMatch(/Jane has no credit account/);
    expect(by(facts({ customer: null }), 'credit_sale').available).toBe(false);
  });

  it('refuses a credit sale over the limit when the company refuses, and warns when it holds for approval', () => {
    const over = { name: 'Acme', hasCreditAccount: true, blocked: false, creditLimit: 5000, available: 600, termDays: 30, overdue: false };
    const refuse = by(facts({ customer: over, settings: { ...facts().settings, credit_sale: { ...kind, overLimit: 'refuse' } } }), 'credit_sale');
    expect(refuse.available).toBe(false);
    expect(refuse.reason).toMatch(/over their limit by KES 400\.00/);
    const hold = by(facts({ customer: over }), 'credit_sale');
    expect(hold.available).toBe(true);
    expect(hold.cautions.join(' ')).toMatch(/KES 400\.00 over .*credit limit.*wait for approval/);
    expect(by(facts(), 'credit_sale').effects.join(' ')).toMatch(/Within their credit limit: KES 4,000\.00 available/);
  });

  it('only asks for the limit when the company checks it, and tells of an overdue invoice', () => {
    const over = { name: 'Acme', hasCreditAccount: true, blocked: false, creditLimit: 5000, available: 10, termDays: 30, overdue: true };
    const off = by(facts({ customer: over, settings: { ...facts().settings, credit_sale: { ...kind, creditCheck: 'off' } } }), 'credit_sale');
    expect(off.available).toBe(true);
    expect(off.cautions).toEqual([]);
    expect(by(facts({ customer: over, settings: { ...facts().settings, credit_sale: { ...kind, creditCheck: 'limit_and_overdue', overLimit: 'hold' } } }), 'credit_sale').cautions.join(' ')).toMatch(/overdue invoice/);
  });

  it('needs an open shift and no delivery charge for a cash sale, and no address', () => {
    expect(by(facts({ shiftOpen: false }), 'cash_sale').reason).toMatch(/Open a shift/);
    expect(by(facts({ deliveryFee: 200 }), 'cash_sale').reason).toMatch(/delivery charge/);
    const noAddress = conversionChoices(facts({ addressComplete: false }));
    expect(noAddress.find((c) => c.target === 'cash_sale')?.available).toBe(true);
    expect(noAddress.find((c) => c.target === 'sales_invoice')?.reason).toMatch(/delivery address/);
  });

  it('refuses a blocked customer everywhere, and a target the person has no permission for', () => {
    const blocked = conversionChoices(facts({ customer: { name: 'Bad Debts', hasCreditAccount: true, blocked: true, creditLimit: 1, available: 1, termDays: 0, overdue: false } }));
    expect(blocked.every((c) => !c.available && (c.reason ?? '').includes('blocked'))).toBe(true);
    expect(by(facts({ can: { sales_order: true, sales_invoice: false, credit_sale: true, cash_sale: true } }), 'sales_invoice').reason).toMatch(/permission to create sales invoices/);
  });

  it('describes what each will do from the company\'s own settings', () => {
    expect(by(facts(), 'sales_order').effects.join(' ')).toMatch(/raise the tax invoice later/);
    expect(by(facts({ settings: { ...facts().settings, sales_order: { ...kind, invoice: 'with_document', stockRelease: 'on_issue' } } }), 'sales_order').effects.join(' ')).toMatch(/invoice is issued with the order.*|stock leaves as soon/s);
    expect(by(facts(), 'sales_invoice').effects.join(' ')).toMatch(/tax invoice is made now/);
    expect(by(facts(), 'cash_sale').effects.join(' ')).toMatch(/receipt is the signed tax invoice/);
    expect(by(facts({ settings: { ...facts().settings, credit_sale: { ...kind, creditDays: 'fixed', fixedDays: 14 } } }), 'credit_sale').effects.join(' ')).toMatch(/Due in 14 days/);
  });

  it('knows a target when it sees one', () => {
    expect(isQuoteTarget('cash_sale')).toBe(true);
    expect(isQuoteTarget('refund')).toBe(false);
  });

  it('makes the same sale key for the same quote, and a valid v4-shaped id', () => {
    const hash = (t: string) => createHash('sha256').update(t).digest('hex');
    expect(conversionKey('q1', hash)).toBe(conversionKey('q1', hash));
    expect(conversionKey('q1', hash)).not.toBe(conversionKey('q2', hash));
    expect(conversionKey('q1', hash)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
