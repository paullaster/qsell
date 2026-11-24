import { describe, expect, it } from 'vitest';
import { searchReports } from './search';

const items = [
  {
    title: 'Receivables ageing',
    question: 'Who owes us money, how much, and how late is it?',
    keywords: ['debtors', 'who owes us'],
    familyLabel: 'Finance',
  },
  {
    title: 'What we owe (payables ageing)',
    question: 'Which suppliers do we owe?',
    keywords: ['creditors'],
    familyLabel: 'Vendors and purchasing',
  },
  {
    title: 'Trial balance',
    question: 'Do the books balance?',
    keywords: ['ledger balances'],
    familyLabel: 'Finance',
  },
  {
    title: 'Delivery report',
    question: 'How many deliveries did we make?',
    keywords: ['rider pay'],
    familyLabel: 'Delivery and logistics',
  },
];

describe('searchReports', () => {
  it('returns everything in order for an empty search', () => {
    expect(searchReports(items, '').map((i) => i.title)).toEqual(items.map((i) => i.title));
    expect(searchReports(items, '   ')).toHaveLength(4);
  });

  it('finds by title, best match first', () => {
    expect(searchReports(items, 'ageing').map((i) => i.title)).toEqual([
      'Receivables ageing',
      'What we owe (payables ageing)',
    ]);
    expect(searchReports(items, 'trial')[0]?.title).toBe('Trial balance');
  });

  it('ranks a title that starts with the word above one that merely contains it', () => {
    const list = [
      { title: 'Customer wallets', question: '', keywords: [], familyLabel: 'x' },
      { title: 'Wallet liability', question: '', keywords: [], familyLabel: 'x' },
    ];
    expect(searchReports(list, 'wallet').map((i) => i.title)).toEqual([
      'Customer wallets',
      'Wallet liability',
    ]);
  });

  it('finds by keyword, family and question', () => {
    expect(searchReports(items, 'debtors')[0]?.title).toBe('Receivables ageing');
    expect(searchReports(items, 'logistics')[0]?.title).toBe('Delivery report');
    expect(searchReports(items, 'suppliers')[0]?.title).toBe('What we owe (payables ageing)');
  });

  it('needs every word, in any order, ignoring case and accents', () => {
    expect(searchReports(items, 'AGEING receivables').map((i) => i.title)).toEqual([
      'Receivables ageing',
    ]);
    expect(searchReports(items, 'ageing deliveries')).toEqual([]);
    expect(searchReports(items, 'RÉCEIVABLES')).toHaveLength(1);
  });

  it('returns nothing for a word nothing contains and never throws on odd input', () => {
    expect(searchReports(items, 'zzzz')).toEqual([]);
    expect(searchReports(items, '(((')).toHaveLength(4);
    expect(searchReports([], 'x')).toEqual([]);
  });
});
