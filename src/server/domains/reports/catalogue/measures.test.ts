import { describe, expect, it } from 'vitest';
import { EN } from '@/lib/reports/messages/en';
import { ORDER_STATUSES } from '@/lib/order-admin';
import type { PaymentStatus } from '@/types/index';
import { DIMENSION_CODES, DIMENSIONS, isDimensionCode } from './dimensions';
import { MEASURE_CODES, MEASURES, isMeasureCode, measure } from './measures';
import { catalogueVersion } from './version';

const PAYMENT_STATUSES = [
  'unpaid',
  'pending_verification',
  'partially_paid',
  'paid',
  'reconciled',
  'discrepancy',
  'failed',
] as const satisfies readonly PaymentStatus[];
const APPROVAL_STATUSES = ['none', 'pending', 'approved', 'rejected', 'draft'] as const;
const ATTEMPT_STATUSES = [
  'initiated',
  'pending',
  'awaiting_redirect',
  'successful',
  'failed',
  'cancelled',
  'expired',
] as const;

const VALID_STATUSES: Record<string, readonly string[]> = {
  status: ORDER_STATUSES,
  payment_status: PAYMENT_STATUSES,
  approval_status: APPROVAL_STATUSES,
};

describe('measure catalogue', () => {
  it('has unique codes written as area.name', () => {
    expect(new Set(MEASURE_CODES).size).toBe(MEASURE_CODES.length);
    for (const code of MEASURE_CODES) expect(code, code).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
  });

  it('gives every measure a label and a meaning that exist in the English catalogue', () => {
    for (const m of Object.values(MEASURES)) {
      expect(EN[m.labelId], `${m.code} label`).toBeTruthy();
      expect(EN[m.meaningId], `${m.code} meaning`).toBeTruthy();
      expect(m.formula.trim(), `${m.code} formula`).not.toBe('');
      expect(m.version, `${m.code} version`).toMatch(/^\d{4}-\d{2}-v\d+$/);
    }
  });

  it('only uses dimensions that exist', () => {
    for (const m of Object.values(MEASURES)) {
      expect(m.dimensions.length, m.code).toBeGreaterThan(0);
      for (const d of m.dimensions) expect(isDimensionCode(d), `${m.code} uses ${d}`).toBe(true);
      expect(new Set(m.dimensions).size, `${m.code} repeats a dimension`).toBe(m.dimensions.length);
    }
  });

  it('keeps ratios computed from additive sums, never added up', () => {
    for (const m of Object.values(MEASURES)) {
      if (m.aggregation === 'ratio') {
        expect(m.additive, `${m.code} is a ratio and cannot be additive`).toBe(false);
        expect(m.ratio, `${m.code} must name its parts`).toBeDefined();
        const parts = [m.ratio?.numerator ?? '', m.ratio?.denominator ?? ''];
        for (const p of parts) {
          expect(isMeasureCode(p), `${m.code} refers to ${p}`).toBe(true);
          expect(measure(p)?.additive, `${m.code} divides ${p}, which must be additive`).toBe(true);
        }
      } else {
        expect(m.ratio, `${m.code} is not a ratio`).toBeUndefined();
      }
    }
  });

  it('does not let a ratio mix a cost measure with a normal one without being a cost measure itself', () => {
    for (const m of Object.values(MEASURES)) {
      if (m.ratio === undefined) continue;
      const parts = [measure(m.ratio.numerator), measure(m.ratio.denominator)];
      if (parts.some((p) => p?.sensitivity === 'cost')) {
        expect(m.sensitivity, `${m.code} is worked out from cost, so it reveals cost`).toBe('cost');
      }
    }
  });

  it('marks everything that reveals product cost as a cost measure', () => {
    for (const code of [
      'profit.gross',
      'profit.margin',
      'profit.known_revenue',
      'profit.all_revenue',
      'profit.cost_coverage',
      'inventory.stock_value',
    ]) {
      expect(measure(code)?.sensitivity, code).toBe('cost');
    }
  });

  it('states a document rule for every sales measure, using real statuses', () => {
    for (const m of Object.values(MEASURES)) {
      for (const rule of m.rules) {
        for (const s of rule.statuses) {
          const allowed =
            rule.document === 'payment_attempt' && s.field === 'status'
              ? ATTEMPT_STATUSES
              : VALID_STATUSES[s.field];
          for (const value of [...(s.counted ?? []), ...(s.excluded ?? [])]) {
            expect(allowed, `${m.code}: ${s.field}`).toContain(value);
          }
        }
      }
    }
    for (const code of ['sales.total', 'sales.orders', 'sales.tax', 'sales.average_order']) {
      const rule = measure(code)?.rules[0];
      expect(rule, code).toBeDefined();
      expect(rule?.statuses.find((s) => s.field === 'status')?.excluded).toEqual([
        'failed',
        'cancelled',
        'refunded',
      ]);
    }
  });

  it('counts sales the same way for every sales measure', () => {
    const first = JSON.stringify(measure('sales.total')?.rules[0]);
    for (const code of ['sales.orders', 'sales.tax', 'sales.average_order', 'profit.gross']) {
      expect(JSON.stringify(measure(code)?.rules[0]), code).toBe(first);
    }
  });

  it('reports a catalogue version that equals the newest measure version', () => {
    const newest = Object.values(MEASURES)
      .map((m) => m.version)
      .sort()
      .at(-1);
    expect(catalogueVersion()).toBe(newest);
  });
});

describe('dimensions', () => {
  it('lists every dimension once, with a label in the catalogue', () => {
    expect(new Set(DIMENSION_CODES).size).toBe(DIMENSION_CODES.length);
    for (const code of DIMENSION_CODES) {
      expect(DIMENSIONS[code].code).toBe(code);
      expect(EN[DIMENSIONS[code].labelId], code).toBeTruthy();
    }
  });

  it('refuses a code it does not know', () => {
    expect(isDimensionCode('branch')).toBe(true);
    expect(isDimensionCode('salesman')).toBe(false);
    expect(isDimensionCode('')).toBe(false);
  });

  it('never cuts stock by a person or a till', () => {
    for (const code of ['inventory.stock_value', 'inventory.out_of_stock', 'inventory.low_stock']) {
      const dims = measure(code)?.dimensions ?? [];
      expect(dims).not.toContain('salesperson');
      expect(dims).not.toContain('customer');
    }
  });
});
