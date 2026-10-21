import { describe, expect, it } from 'vitest';
import type { PulledLine } from '@/server/domains/payments/statement-pull';
import { chronological } from './statement-pull-service';

const line = (date: string, description: string, order: number): PulledLine => ({ date, description, reference: null, counterparty: null, amountCents: 100, balanceCents: null, order });

describe('the order of a pulled statement', () => {
  it('puts a newest-first answer in the order things happened, including lines of one day', () => {
    const out = chronological([line('2026-10-12', 'c', 0), line('2026-10-11', 'b2', 1), line('2026-10-11', 'b1', 2), line('2026-10-10', 'a', 3)]);
    expect(out.map((l) => l.description)).toEqual(['a', 'b1', 'b2', 'c']);
  });

  it('leaves an oldest-first answer as it came', () => {
    const out = chronological([line('2026-10-10', 'a', 0), line('2026-10-11', 'b1', 1), line('2026-10-11', 'b2', 2)]);
    expect(out.map((l) => l.description)).toEqual(['a', 'b1', 'b2']);
  });

  it('copes with nothing and with one line', () => {
    expect(chronological([])).toEqual([]);
    expect(chronological([line('2026-10-10', 'only', 0)]).map((l) => l.description)).toEqual(['only']);
  });
});
