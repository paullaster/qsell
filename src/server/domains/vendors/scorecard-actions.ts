'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { reportRange } from '@/lib/vendor-insights';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceError('NOT_FOUND', 'That record does not exist.');
  return value;
};
const str = (value: unknown, max = 500): string => (typeof value === 'string' ? value.slice(0, max) : '');
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const PATHS = ['/admin/vendors/scorecards'];

export async function scorecardsAction(from?: string, to?: string) {
  return await run('scorecards:read', { surface: 'scorecards', action: 'view' }, async (ctx) => {
    const card = await getContainer().scorecards.scorecards(ctx.companyId, reportRange(from, to, businessDate()));
    const [review, manage] = await Promise.all([canPermission('scorecards:review'), canPermission('scorecards:manage')]);
    return { ...card, can: { review, manage } };
  });
}

export async function reviewVendorAction(vendorId: string, ratings: unknown, comment: string) {
  return await run('scorecards:review', { surface: 'scorecards', action: 'review' }, async (ctx) => await getContainer().scorecards.addReview(ctx, id(vendorId), obj(ratings), str(comment, 600)), PATHS);
}

export async function saveCriterionAction(criterionId: string | null, form: unknown) {
  return await run('scorecards:manage', { surface: 'scorecards', action: criterionId === null ? 'create' : 'update' }, async (ctx) => {
    const f = obj(form);
    return await getContainer().scorecards.saveCriterion(ctx, criterionId === null ? null : id(criterionId), { name: str(f.name, 100), source: str(f.source, 30), weight: str(f.weight, 4), active: f.active !== false });
  }, PATHS);
}

export async function vendorReviewsAction(vendorId: string) {
  return await run('scorecards:read', { surface: 'scorecards', action: 'reviews' }, async (ctx) => ({ reviews: await getContainer().scorecards.reviews(ctx.companyId, id(vendorId)) }));
}
