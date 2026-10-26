import { describe, expect, it } from 'vitest';
import { DEFAULT_CRITERIA, checkCriterion, checkRatings, gradeOf, partValue, ratingPercent, scoreOf } from './vendor-scorecard';

const measures = { onTimePercent: 90, rejectedPercent: 10, accuratePercent: 80, respondedPercent: null };

describe('vendor scorecard', () => {
  it('turns each source into a share out of 100', () => {
    expect(partValue('on_time', measures, null)).toBe(90);
    expect(partValue('accepted', measures, null)).toBe(90);
    expect(partValue('invoice_accuracy', measures, null)).toBe(80);
    expect(partValue('rfq_response', measures, null)).toBeNull();
    expect(partValue('rating', measures, 4)).toBe(80);
    expect(partValue('rating', measures, null)).toBeNull();
    expect(ratingPercent(1)).toBe(20);
  });
  it('weighs only the parts that have something behind them, and gives no score on too little', () => {
    const parts = DEFAULT_CRITERIA.map((c, i) => ({ criterionId: String(i), name: c.name, weight: c.weight, value: partValue(c.source, measures, null) }));
    // on time 30×90, accepted 25×90, invoices 15×80 over a weight of 70 (rfq 10 and service 20 have nothing)
    expect(scoreOf(parts)).toEqual({ score: 87.9, coverage: 70 });
    expect(scoreOf([{ criterionId: 'a', name: 'a', weight: 30, value: 100 }, { criterionId: 'b', name: 'b', weight: 70, value: null }])).toEqual({ score: null, coverage: 30 });
    expect(scoreOf([])).toEqual({ score: null, coverage: 0 });
  });
  it('names the grade', () => {
    expect(gradeOf(null).letter).toBe('–');
    expect([90, 75, 60, 40].map((s) => gradeOf(s).letter)).toEqual(['A', 'B', 'C', 'D']);
    expect(gradeOf(85).letter).toBe('A');
    expect(gradeOf(84.9).letter).toBe('B');
  });
  it('checks a criterion and the ratings given', () => {
    expect(checkCriterion({ name: 'Packaging', source: 'rating', weight: '10' })).toEqual({});
    expect(Object.keys(checkCriterion({ name: 'x', source: 'mood', weight: '0' })).sort()).toEqual(['name', 'source', 'weight']);
    expect(checkRatings({ a: 4, b: '5', c: '' }, ['a', 'b', 'c'])).toEqual({ ok: true, value: [{ criterionId: 'a', rating: 4 }, { criterionId: 'b', rating: 5 }] });
    expect(checkRatings({ a: 6 }, ['a']).ok).toBe(false);
    expect(checkRatings({ z: 3 }, ['a']).ok).toBe(false);
    expect(checkRatings({}, ['a']).ok).toBe(false);
    expect(checkRatings({ a: 2.5 }, ['a']).ok).toBe(false);
  });
});
