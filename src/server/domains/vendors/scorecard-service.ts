import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { scorecardCriteria, users, vendorReviewRatings, vendorReviews, vendors } from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import { DEFAULT_CRITERIA, checkCriterion, checkRatings, gradeOf, partValue, scoreOf, type CriterionForm, type CriterionSource } from '@/lib/vendor-scorecard';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import { isUniqueViolation } from '@/server/domains/settings/errors';
import type { VendorInsightsService } from './insights-service';

/**
 * The vendor scorecard: the company's chosen criteria (measured from documents, or rated by people), weighted into one score per
 * vendor for a period. Reviews are kept, never changed. A vendor with too little behind it gets no score rather than a poor one.
 */
export class ScorecardService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly insights: VendorInsightsService,
  ) {}

  /** The criteria, set up with the standard ones the first time they are asked for. */
  async criteria(companyId: string, includeOff = true) {
    let rows = await this.db.select().from(scorecardCriteria).where(eq(scorecardCriteria.companyId, companyId)).orderBy(asc(scorecardCriteria.createdAt), asc(scorecardCriteria.code));
    if (rows.length === 0) {
      await this.db.insert(scorecardCriteria).values(DEFAULT_CRITERIA.map((c) => ({ companyId, ...c }))).onConflictDoNothing();
      rows = await this.db.select().from(scorecardCriteria).where(eq(scorecardCriteria.companyId, companyId)).orderBy(asc(scorecardCriteria.createdAt), asc(scorecardCriteria.code));
    }
    return rows.filter((r) => includeOff || r.active).map((r) => ({ id: r.id, code: r.code, name: r.name, source: r.source, weight: r.weight, active: r.active }));
  }

  async saveCriterion(ctx: FinanceContext, id: string | null, form: CriterionForm & { active: boolean }): Promise<{ id: string }> {
    const first = Object.values(checkCriterion(form))[0];
    if (has(first)) throw new FinanceError('INVALID', first);
    const code = form.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    try {
      if (id === null) {
        await this.criteria(ctx.companyId);
        const [made] = await this.db.insert(scorecardCriteria).values({ companyId: ctx.companyId, code, name: form.name.trim(), source: form.source as CriterionSource, weight: Number(form.weight), active: form.active }).returning({ id: scorecardCriteria.id });
        return { id: made?.id ?? '' };
      }
      const [row] = await this.db.update(scorecardCriteria).set({ name: form.name.trim(), source: form.source as CriterionSource, weight: Number(form.weight), active: form.active, updatedAt: new Date() }).where(and(eq(scorecardCriteria.companyId, ctx.companyId), eq(scorecardCriteria.id, id))).returning({ id: scorecardCriteria.id });
      if (row === undefined) throw new FinanceError('NOT_FOUND', 'That criterion does not exist.');
      return { id: row.id };
    } catch (error) {
      if (isUniqueViolation(error)) throw new FinanceError('DUPLICATE', 'There is already a criterion with that name.');
      throw error;
    }
  }

  async addReview(ctx: FinanceContext, vendorId: string, ratings: Record<string, unknown>, comment: string): Promise<{ id: string }> {
    const rated = (await this.criteria(ctx.companyId, false)).filter((c) => c.source === 'rating');
    const checked = checkRatings(ratings, rated.map((c) => c.id));
    if (!checked.ok) throw new FinanceError('INVALID', checked.error);
    const [v] = await this.db.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, vendorId)));
    if (v === undefined) throw new FinanceError('NOT_FOUND', 'That vendor does not exist.');
    return await this.db.transaction(async (tx) => {
      const [made] = await tx.insert(vendorReviews).values({ companyId: ctx.companyId, vendorId, reviewerId: ctx.actor.id, comment: trimToNull(comment)?.slice(0, 500) ?? null }).returning({ id: vendorReviews.id });
      const id = made?.id ?? '';
      await tx.insert(vendorReviewRatings).values(checked.value.map((r) => ({ reviewId: id, criterionId: r.criterionId, rating: r.rating })));
      return { id };
    });
  }

  /** Every vendor with something to score in the period, best first; vendors with too little behind them come last without a score. */
  async scorecards(companyId: string, range: { from: string; to: string }) {
    const [criteria, perf] = await Promise.all([this.criteria(companyId, false), this.insights.performance(companyId, range)]);
    const ratingRows = await this.db
      .select({ vendorId: vendorReviews.vendorId, criterionId: vendorReviewRatings.criterionId, average: sql<string>`avg(${vendorReviewRatings.rating})::text`, n: sql<number>`count(*)::int` })
      .from(vendorReviewRatings)
      .innerJoin(vendorReviews, eq(vendorReviews.id, vendorReviewRatings.reviewId))
      .where(and(eq(vendorReviews.companyId, companyId), sql`${vendorReviews.createdAt}::date BETWEEN ${range.from}::date AND ${range.to}::date`))
      .groupBy(vendorReviews.vendorId, vendorReviewRatings.criterionId);
    const reviewed = new Set(ratingRows.map((r) => r.vendorId));
    const ids = [...new Set([...perf.lines.map((l) => l.vendorId), ...reviewed])];
    if (ids.length === 0) return { range, criteria, lines: [] };
    const names = await this.db.select({ id: vendors.id, name: vendors.legalName, number: vendors.number }).from(vendors).where(and(eq(vendors.companyId, companyId), inArray(vendors.id, ids)));
    const lines = names.map((v) => {
      const p = perf.lines.find((l) => l.vendorId === v.id);
      const measures = { onTimePercent: p?.onTimePercent ?? null, rejectedPercent: p?.rejectedPercent ?? null, accuratePercent: p?.accuratePercent ?? null, respondedPercent: p?.respondedPercent ?? null };
      const parts = criteria.map((c) => {
        const mine = ratingRows.find((r) => r.vendorId === v.id && r.criterionId === c.id);
        return { criterionId: c.id, name: c.name, weight: c.weight, value: partValue(c.source, measures, mine === undefined ? null : Number(mine.average)) };
      });
      const { score, coverage } = scoreOf(parts);
      return { vendorId: v.id, name: v.name, number: v.number, score, coverage, grade: gradeOf(score), parts, reviews: ratingRows.filter((r) => r.vendorId === v.id).reduce((m, r) => Math.max(m, r.n), 0) };
    });
    lines.sort((a, b) => {
      if ((a.score === null) !== (b.score === null)) return a.score === null ? 1 : -1;
      if (a.score !== b.score) return (b.score ?? 0) - (a.score ?? 0);
      return a.name.localeCompare(b.name);
    });
    return { range, criteria, lines };
  }

  async reviews(companyId: string, vendorId: string, limit = 20) {
    const rows = await this.db.select().from(vendorReviews).where(and(eq(vendorReviews.companyId, companyId), eq(vendorReviews.vendorId, vendorId))).orderBy(desc(vendorReviews.createdAt)).limit(limit);
    const ids = [...new Set(rows.map((r) => r.reviewerId).filter((x): x is string => x !== null && /^[0-9a-f-]{36}$/i.test(x)))];
    const names = new Map((ids.length === 0 ? [] : await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]));
    return rows.map((r) => ({ id: r.id, at: r.createdAt.toISOString(), who: r.reviewerId === null ? null : (names.get(r.reviewerId) ?? 'Someone'), comment: r.comment }));
  }
}
