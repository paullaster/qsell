import { describe, expect, it } from 'vitest';
import {
  centsFrom,
  checkPullRange,
  fillTemplate,
  jengaCursor,
  jengaFullStatementPlain,
  jengaLines,
  mappedLines,
  readJengaPage,
  readStatementMap,
  MAX_PULL_DAYS,
} from './statement-pull';

// Shaped like the example in Jenga's "Account Full Statement" guide.
const answer = {
  status: true,
  code: 0,
  message: 'Success',
  data: {
    balance: 839509.37,
    currency: 'KES',
    accountNumber: '00201XXXX14605',
    transactions: [
      {
        reference: '697210075664341',
        date: '2023-10-13T18:14:39.000',
        amount: 1.0,
        serial: '1',
        description: 'JENGA CHARGE CREDIT 697210075493611',
        postedDateTime: '2023-10-13T18:14:39.000',
        type: 'Credit',
        runningBalance: { amount: 839509.37, currency: 'KES' },
        transactionId: '54172',
      },
      {
        reference: '697210075664342',
        date: '2023-10-12T09:00:00.000',
        amount: '1,250.50',
        serial: '2',
        description: 'ATM WITHDRAWAL',
        postedDateTime: '2023-10-12T09:01:00.000',
        type: 'Debit',
        runningBalance: { amount: '839508.37', currency: 'KES' },
      },
    ],
  },
};

describe('what is signed for Jenga', () => {
  it('is the account number, the country and the last day, joined with nothing between', () => {
    expect(
      jengaFullStatementPlain({
        accountNumber: '00201XXXX14605',
        countryCode: 'KE',
        fromDate: '2023-10-01',
        toDate: '2023-10-13',
      }),
    ).toBe('00201XXXX14605KE2023-10-13');
  });
});

describe("Jenga's statement", () => {
  it('is read into signed lines: a credit is money in, a debit money out', () => {
    const page = readJengaPage(answer);
    expect(page.problem).toBeNull();
    const { lines, problem } = jengaLines(page.transactions);
    expect(problem).toBeNull();
    expect(lines).toEqual([
      {
        date: '2023-10-13',
        description: 'JENGA CHARGE CREDIT 697210075493611',
        reference: '697210075664341',
        counterparty: null,
        amountCents: 100,
        balanceCents: 83_950_937,
        order: 0,
      },
      {
        date: '2023-10-12',
        description: 'ATM WITHDRAWAL',
        reference: '697210075664342',
        counterparty: null,
        amountCents: -125_050,
        balanceCents: 83_950_837,
        order: 1,
      },
    ]);
  });

  it('refuses a refusal, a missing list and an unreadable transaction in words', () => {
    expect(readJengaPage({ status: false, message: 'Invalid signature' }).problem).toBe(
      'Invalid signature',
    );
    expect(readJengaPage({ status: true, data: {} }).problem).toContain('no list of transactions');
    expect(readJengaPage('nope').problem).toContain('did not answer');
    expect(readJengaPage({ status: true, data: { transactions: [1] } }).problem).toContain(
      'Transaction 1',
    );
    expect(jengaLines([{ postedDateTime: 'x', amount: 1, type: 'Credit' }]).problem).toContain(
      'date',
    );
    expect(
      jengaLines([{ postedDateTime: '2023-10-13T00:00:00', amount: 'abc', type: 'Credit' }])
        .problem,
    ).toContain('amount');
    expect(
      jengaLines([{ postedDateTime: '2023-10-13T00:00:00', amount: 1, type: 'Transfer' }]).problem,
    ).toContain('neither a credit nor a debit');
    expect(
      jengaLines([{ postedDateTime: '2023-10-13T00:00:00', amount: 0, type: 'Credit' }]).problem,
    ).toContain('amount');
  });

  it('gives the fields that say "continue after this transaction"', () => {
    expect(jengaCursor(answer.data.transactions[0])).toEqual({
      reference: '697210075664341',
      serial: '1',
      postedDateTime: '2023-10-13T18:14:39.000',
      date: '2023-10-13T18:14:39.000',
      runningBalance: { amount: 839509.37, currency: 'KES' },
    });
  });
});

describe('amounts from a bank', () => {
  it('are read as cents from numbers and text', () => {
    expect(centsFrom(12.34)).toBe(1234);
    expect(centsFrom('1,250.50')).toBe(125_050);
    expect(centsFrom('-5')).toBe(-500);
    expect(centsFrom('abc')).toBeNull();
    expect(centsFrom(null)).toBeNull();
    expect(centsFrom(Number.NaN)).toBeNull();
  });
});

describe('the range of a pull', () => {
  const today = '2026-10-21';
  it('accepts real days in order that are not in the future', () => {
    expect(checkPullRange('2026-10-01', '2026-10-21', today)).toBeNull();
    expect(checkPullRange('2026-10-21', '2026-10-21', today)).toBeNull();
  });
  it('says what is wrong in words', () => {
    expect(checkPullRange('1/10/2026', '2026-10-21', today)).toContain('YYYY-MM-DD');
    expect(checkPullRange('2026-13-01', '2026-13-02', today)).toContain('not a real day');
    expect(checkPullRange('2026-10-21', '2026-10-01', today)).toContain('not be after');
    expect(checkPullRange('2026-10-01', '2026-10-22', today)).toContain('future');
    expect(checkPullRange('2026-01-01', '2026-10-21', today)).toContain(String(MAX_PULL_DAYS));
  });
});

describe('a bank described in the provider settings', () => {
  const map = readStatementMap({
    list: 'result.items',
    date: 'bookedOn',
    description: 'narrative',
    reference: 'ref',
    balance: 'balance.amount',
    amountAbs: 'value',
    direction: 'dc',
    creditWords: ['CR'],
  });

  it('needs the list, the date, the words and an amount (signed, or with its direction)', () => {
    expect(map).not.toBeNull();
    expect(readStatementMap({ list: 'a', date: 'b', description: 'c' })).toBeNull();
    expect(readStatementMap({ list: 'a', date: 'b', description: 'c', amountAbs: 'x' })).toBeNull();
    expect(
      readStatementMap({ list: 'a', date: 'b', description: 'c', amount: 'x' }),
    ).not.toBeNull();
    expect(readStatementMap(null)).toBeNull();
    expect(readStatementMap({ date: 'b', description: 'c', amount: 'x' })).toBeNull();
  });

  it('reads lines from wherever the mapping points, with the direction in its own field', () => {
    if (map === null) throw new Error('no map');
    const out = mappedLines(
      {
        result: {
          items: [
            {
              bookedOn: '2026-10-02',
              narrative: 'Salary',
              ref: 'R1',
              value: '900.00',
              dc: 'CR',
              balance: { amount: 1000 },
            },
            { bookedOn: '2026-10-03', narrative: 'Rent', value: 400, dc: 'DR' },
          ],
        },
      },
      map,
    );
    expect(out.problem).toBeNull();
    expect(out.lines.map((l) => [l.date, l.amountCents, l.reference, l.balanceCents])).toEqual([
      ['2026-10-02', 90_000, 'R1', 100_000],
      ['2026-10-03', -40_000, null, null],
    ]);
  });

  it('reads a signed amount when the mapping has one', () => {
    const signed = readStatementMap({ list: 'rows', date: 'd', description: 'n', amount: 'a' });
    if (signed === null) throw new Error('no map');
    expect(
      mappedLines({ rows: [{ d: '2026-10-02T10:00:00', n: 'x', a: '-12.5' }] }, signed).lines[0]
        ?.amountCents,
    ).toBe(-1250);
  });

  it('says where it looked when the list is missing, and refuses what cannot be read', () => {
    if (map === null) throw new Error('no map');
    expect(mappedLines({}, map).problem).toBe('The answer has no list at "result.items".');
    expect(
      mappedLines(
        { result: { items: [{ bookedOn: 'x', narrative: 'a', value: 1, dc: 'CR' }] } },
        map,
      ).problem,
    ).toContain('date');
    expect(
      mappedLines(
        { result: { items: [{ bookedOn: '2026-10-02', narrative: 'a', value: 1 }] } },
        map,
      ).problem,
    ).toContain('amount');
  });
});

describe('templates', () => {
  it('put the account, days and country where they belong', () => {
    expect(
      fillTemplate('/accounts/{account}/tx?from={from}&to={to}&c={country}', {
        accountNumber: '123',
        countryCode: 'KE',
        fromDate: '2026-10-01',
        toDate: '2026-10-20',
      }),
    ).toBe('/accounts/123/tx?from=2026-10-01&to=2026-10-20&c=KE');
  });
});
