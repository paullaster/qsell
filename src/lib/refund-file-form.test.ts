import { describe, expect, it } from 'vitest';
import { MAX_PICK, confirmProblem, fileProblem, itemTone, itemWords, ownApprovals, pickedTotal, toggleAll, toggleOne, type Candidate } from './refund-file-form';

const rows: Candidate[] = [
  { id: 'a', amount: '580.00', approvedBy: 'u1' },
  { id: 'b', amount: '120.50', approvedBy: null },
  { id: 'c', amount: '0.05', approvedBy: 'u2' },
];

describe('choosing refunds for a file', () => {
  it('adds up the chosen ones to the cent', () => {
    expect(pickedTotal(rows, new Set(['a', 'b', 'c']))).toBe('700.55');
    expect(pickedTotal(rows, new Set())).toBe('0.00');
  });

  it('warns about refunds the person approved themselves', () => {
    expect(ownApprovals(rows, new Set(['a', 'c']), 'u1')).toEqual(['a']);
    expect(ownApprovals(rows, new Set(['a']), null)).toEqual([]);
  });

  it('ticks and clears without touching the set it was given', () => {
    const none = new Set<string>();
    const one = toggleOne(none, 'a');
    expect([...one]).toEqual(['a']);
    expect(none.size).toBe(0);
    expect([...toggleOne(one, 'a')]).toEqual([]);
    expect(toggleAll(rows, new Set()).size).toBe(3);
    expect(toggleAll(rows, new Set(['a', 'b', 'c'])).size).toBe(0);
  });

  it('never ticks more than a file can hold', () => {
    const many: Candidate[] = Array.from({ length: MAX_PICK + 20 }, (_, i) => ({ id: String(i), amount: '1.00', approvedBy: null }));
    expect(toggleAll(many, new Set()).size).toBe(MAX_PICK);
  });
});

describe('the make-a-file form', () => {
  const ok = { methodId: 'm', formatId: 'csv', picked: 2, executionDate: '2026-10-18', today: '2026-10-17' };
  it('wants something chosen, a bank, a format and a day that has not passed', () => {
    expect(fileProblem(ok)).toBeNull();
    expect(fileProblem({ ...ok, picked: 0 })).toContain('Tick at least one');
    expect(fileProblem({ ...ok, picked: MAX_PICK + 1 })).toContain('at most');
    expect(fileProblem({ ...ok, methodId: null })).toContain('bank');
    expect(fileProblem({ ...ok, formatId: null })).toContain('format');
    expect(fileProblem({ ...ok, executionDate: '2026-10-16' })).toContain('passed');
  });

  it('wants the bank\'s reference and its confirmation before recording payment', () => {
    expect(confirmProblem({ reference: ' ', evidence: 1 })).toContain('reference');
    expect(confirmProblem({ reference: 'B1', evidence: 0 })).toContain('confirmation');
    expect(confirmProblem({ reference: 'B1', evidence: 1 })).toBeNull();
  });
});

describe('the lines of a file', () => {
  it('are coloured and worded by where they are', () => {
    expect(itemTone('paid')).toBe('green');
    expect(itemTone('released')).toBe('gray');
    expect(itemTone('in_file')).toBe('sky');
    expect(itemWords('in_file')).toBe('in the file');
    expect(itemWords('paid')).toBe('paid');
  });
});
