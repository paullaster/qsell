/** The vendor scorecard: measures taken from documents and ratings people give, weighted by the company into one score. Pure. */

export type CriterionSource = 'on_time' | 'accepted' | 'invoice_accuracy' | 'rfq_response' | 'rating';

export const SOURCE_WORDS: Record<CriterionSource, string> = {
  on_time: 'Deliveries on time (measured)',
  accepted: 'Goods accepted, not refused (measured)',
  invoice_accuracy: 'Invoice lines that matched (measured)',
  rfq_response: 'Quotation requests answered (measured)',
  rating: 'Rated by a person, 1 to 5',
};

export const DEFAULT_CRITERIA: { code: string; name: string; source: CriterionSource; weight: number }[] = [
  { code: 'on_time', name: 'Delivers on time', source: 'on_time', weight: 30 },
  { code: 'accepted', name: 'Goods are accepted', source: 'accepted', weight: 25 },
  { code: 'invoice_accuracy', name: 'Invoices are right', source: 'invoice_accuracy', weight: 15 },
  { code: 'rfq_response', name: 'Answers quotation requests', source: 'rfq_response', weight: 10 },
  { code: 'service', name: 'Service and communication', source: 'rating', weight: 20 },
];

export interface CriterionInput {
  id: string;
  name: string;
  source: CriterionSource;
  weight: number;
}

export interface Measures {
  onTimePercent: number | null;
  rejectedPercent: number | null;
  accuratePercent: number | null;
  respondedPercent: number | null;
}

export interface ScorePart {
  criterionId: string;
  name: string;
  weight: number;
  /** 0 to 100, or null when there is nothing to score it on. */
  value: number | null;
}

/** A rating from 1 to 5 as a share of the best: 1 is 20, 5 is 100. */
export const ratingPercent = (average: number): number => Math.round(average * 20 * 10) / 10;

export function partValue(source: CriterionSource, m: Measures, ratingAverage: number | null): number | null {
  switch (source) {
    case 'on_time':
      return m.onTimePercent;
    case 'accepted':
      return m.rejectedPercent === null ? null : Math.round((100 - m.rejectedPercent) * 10) / 10;
    case 'invoice_accuracy':
      return m.accuratePercent;
    case 'rfq_response':
      return m.respondedPercent;
    case 'rating':
      return ratingAverage === null ? null : ratingPercent(ratingAverage);
  }
}

export const MIN_COVERAGE = 40;

/**
 * The weighted score of the parts that have something behind them, and how much of the total weight that was. A vendor with too
 * little to go on (under 40% of the weight) gets no score, not a poor one.
 */
export function scoreOf(parts: readonly ScorePart[]): { score: number | null; coverage: number } {
  const total = parts.reduce((s, p) => s + p.weight, 0);
  const have = parts.filter((p) => p.value !== null);
  const weight = have.reduce((s, p) => s + p.weight, 0);
  if (total <= 0 || weight <= 0) return { score: null, coverage: 0 };
  const coverage = Math.round((weight / total) * 100);
  const score = Math.round((have.reduce((s, p) => s + p.weight * (p.value ?? 0), 0) / weight) * 10) / 10;
  return { score: coverage < MIN_COVERAGE ? null : score, coverage };
}

export function gradeOf(score: number | null): { letter: string; label: string; tone: 'green' | 'sky' | 'amber' | 'red' | 'gray' } {
  if (score === null) return { letter: '–', label: 'Not enough to go on', tone: 'gray' };
  if (score >= 85) return { letter: 'A', label: 'Excellent', tone: 'green' };
  if (score >= 70) return { letter: 'B', label: 'Good', tone: 'sky' };
  if (score >= 55) return { letter: 'C', label: 'Needs attention', tone: 'amber' };
  return { letter: 'D', label: 'Poor', tone: 'red' };
}

export interface CriterionForm {
  name: string;
  source: string;
  weight: string;
}

export function checkCriterion(f: CriterionForm): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.name.trim().length < 2 || f.name.trim().length > 80) p.name = 'Name it in 2 to 80 characters.';
  if (!Object.hasOwn(SOURCE_WORDS, f.source)) p.source = 'Choose what it is scored on.';
  if (!/^\d{1,3}$/.test(f.weight.trim()) || Number(f.weight) < 1 || Number(f.weight) > 100) p.weight = 'The weight is a whole number from 1 to 100.';
  return p;
}

export function checkRatings(ratings: Record<string, unknown>, allowed: readonly string[]): { ok: true; value: { criterionId: string; rating: number }[] } | { ok: false; error: string } {
  const entries = Object.entries(ratings).filter(([, v]) => v !== '' && v !== null && v !== undefined);
  if (entries.length === 0) return { ok: false, error: 'Give at least one rating.' };
  const out: { criterionId: string; rating: number }[] = [];
  for (const [criterionId, raw] of entries) {
    const rating = typeof raw === 'number' ? raw : Number(raw);
    if (!allowed.includes(criterionId)) return { ok: false, error: 'One of those is not something that is rated.' };
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, error: 'A rating is a whole number from 1 to 5.' };
    out.push({ criterionId, rating });
  }
  return { ok: true, value: out };
}
