import { describe, expect, it } from 'vitest';
import { acceptingApplications, answerProblems, checkAnswer, checkCategory, checkQuestion, emptyCategory, emptyQuestion, passes, scoreTotals, validUntil } from './prequalification';

describe('checkCategory', () => {
  const ok = { ...emptyCategory(), code: 'SOLAR', name: 'Solar panels' };
  it('accepts a good form', () => expect(checkCategory(ok, true)).toEqual({}));
  it('checks code, months, pass mark and window', () => {
    expect(checkCategory({ ...ok, code: 'solar panels' }, true).code).toBeDefined();
    expect(checkCategory({ ...ok, validityMonths: '0' }, true).validityMonths).toBeDefined();
    expect(checkCategory({ ...ok, passMarkPercent: '120' }, true).passMarkPercent).toBeDefined();
    expect(checkCategory({ ...ok, windowFrom: '2026-12-01', windowTo: '2026-11-01' }, true).windowTo).toBeDefined();
    expect(checkCategory({ ...ok, passMarkPercent: '' }, true).passMarkPercent).toBeUndefined();
  });
});

describe('checkQuestion', () => {
  it('needs 2 to 12 distinct choices for a choice question', () => {
    const q = { ...emptyQuestion(), prompt: 'How many staff?', kind: 'choice' as const };
    expect(checkQuestion({ ...q, choices: 'a' }).choices).toBeDefined();
    expect(checkQuestion({ ...q, choices: 'a\na' }).choices).toBeDefined();
    expect(checkQuestion({ ...q, choices: 'a\nb' })).toEqual({});
  });
  it('bounds the weight', () => expect(checkQuestion({ ...emptyQuestion(), prompt: 'Why us?', weight: '101' }).weight).toBeDefined());
});

describe('answers', () => {
  it('checks each kind', () => {
    expect(checkAnswer({ kind: 'yes_no', choices: [] }, 'maybe')).not.toBeNull();
    expect(checkAnswer({ kind: 'number', choices: [] }, '12.5')).toBeNull();
    expect(checkAnswer({ kind: 'number', choices: [] }, 'twelve')).not.toBeNull();
    expect(checkAnswer({ kind: 'choice', choices: ['a', 'b'] }, 'c')).not.toBeNull();
  });
  it('requires required questions only on submit', () => {
    const qs = [{ id: 'q1', prompt: 'x', kind: 'text' as const, choices: [], required: true }];
    expect(answerProblems(qs, {}, false)).toEqual({});
    expect(answerProblems(qs, {}, true).q1).toBeDefined();
    expect(answerProblems(qs, { q1: 'fine' }, true)).toEqual({});
  });
});

describe('scoring', () => {
  const weights = { a: 10, b: 20 };
  it('averages evaluators per question and totals', () => {
    const r = scoreTotals(weights, [
      { questionId: 'a', evaluatorId: 'e1', score: 10 },
      { questionId: 'a', evaluatorId: 'e2', score: 6 },
      { questionId: 'b', evaluatorId: 'e1', score: 15 },
    ]);
    expect(r).toEqual({ total: 23, max: 30 });
  });
  it('passes against a percentage; no mark means no verdict', () => {
    expect(passes(23, 30, 70)).toBe(true);
    expect(passes(20, 30, 70)).toBe(false);
    expect(passes(20, 30, null)).toBeNull();
    expect(passes(0, 0, 70)).toBeNull();
  });
});

describe('dates', () => {
  it('validUntil is the day before the anniversary', () => {
    expect(validUntil('2026-10-24', 24)).toBe('2028-10-23');
    expect(validUntil('2026-01-31', 1)).toBe('2026-02-27');
  });
  it('applications are accepted only when open and inside the window', () => {
    expect(acceptingApplications('open', null, null, '2026-10-24')).toBe(true);
    expect(acceptingApplications('draft', null, null, '2026-10-24')).toBe(false);
    expect(acceptingApplications('open', '2026-11-01', null, '2026-10-24')).toBe(false);
    expect(acceptingApplications('open', null, '2026-10-23', '2026-10-24')).toBe(false);
  });
});
