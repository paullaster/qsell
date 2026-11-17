import { describe, expect, it } from 'vitest';
import { isQuoteRequestEmailKind, quoteRequestEmailContent, type QuoteRequestFacts } from './quote-request-emails';

const facts: QuoteRequestFacts = { tradingName: 'Acme', quoteNumber: 'QT-26-000007', customerName: 'Wanjiru Kamau', customerEmail: 'w@x.co', customerPhone: '0711222333', lines: ['12 × Express lunch: Large fish and Ugali'], neededOn: '2030-05-04', message: 'Office party', total: 'KES 7,440.00' };

describe('quote request emails', () => {
  it('thanks the shopper, says nothing is charged, and repeats what was asked for', () => {
    const c = quoteRequestEmailContent('shopper', facts);
    expect(c.subject).toBe('We have your quote request QT-26-000007');
    expect(c.greeting).toBe('Hello Wanjiru,');
    expect(c.body).toContain('Nothing is ordered or charged until you accept it');
    expect(c.details).toContainEqual(['Asked for', '12 × Express lunch: Large fish and Ugali']);
    expect(c.details).toContainEqual(['Needed on', '2030-05-04']);
  });

  it('tells the staff who asked, how to reach them, and what they wrote', () => {
    const c = quoteRequestEmailContent('staff', facts);
    expect(c.subject).toBe('New quote request QT-26-000007 from Wanjiru Kamau');
    expect(c.details).toContainEqual(['Phone', '0711222333']);
    expect(c.details).toContainEqual(['They wrote', 'Office party']);
    expect(c.cta).toBe('Open Sales Quotes');
  });

  it('leaves out what is not there and greets without a name', () => {
    const bare = { ...facts, customerName: '', customerEmail: null, customerPhone: '', neededOn: '', message: '' };
    const shopper = quoteRequestEmailContent('shopper', bare);
    expect(shopper.greeting).toBe('Hello,');
    expect(shopper.details.some(([k]) => k === 'Needed on')).toBe(false);
    const staff = quoteRequestEmailContent('staff', bare);
    expect(staff.details.some(([k]) => k === 'Email' || k === 'Phone' || k === 'They wrote')).toBe(false);
  });

  it('knows its two kinds', () => {
    expect(isQuoteRequestEmailKind('staff')).toBe(true);
    expect(isQuoteRequestEmailKind('other')).toBe(false);
  });
});
