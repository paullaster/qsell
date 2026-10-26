'use server';

import { headers } from 'next/headers';
import { auth } from '@/auth';
import { getContainer } from '@/server/di/container';
import { runSetting, type SettingsResult } from '@/server/domains/settings/action-runner';
import { SettingsError } from '@/server/domains/settings/errors';
import { clientAddress, waitMessage } from '@/lib/rate-limit';
import { parseReviewInput, type PublicReview, type RatingSummary, type ReviewEligibility } from '@/lib/reviews';
import { ReviewsService, type Reviewer, type ReviewStatus } from './service';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** The signed-in shopper, from the session only. Staff and vendors are not shoppers and cannot write a review. */
async function currentReviewer(): Promise<Reviewer | null> {
  try {
    const user = (await auth())?.user;
    if (user?.role !== 'customer') return null;
    const email = user.email.toLowerCase().trim();
    return { key: user.id, name: user.name, email, ownerIds: [user.id, user.customerStoreId ?? ''].filter((id) => id !== '') };
  } catch {
    return null;
  }
}

const idOf = (raw: unknown): string | null => (typeof raw === 'string' && raw !== '' && raw.length <= 100 ? raw : null);

/** Public: what the approved reviews of a product add up to, and its first page. */
export async function productReviewsAction(raw: unknown): Promise<Result<{ summary: RatingSummary; reviews: PublicReview[]; nextCursor: string | null }>> {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const productId = idOf(input.productId);
  if (productId === null) return { ok: false, error: 'That product could not be found.' };
  const cursor = typeof input.cursor === 'string' && input.cursor.length <= 600 ? input.cursor : null;
  try {
    const [summary, page] = await Promise.all([cursor === null ? ReviewsService.summary(productId) : Promise.resolve({ average: 0, count: 0, distribution: [] }), ReviewsService.page(productId, cursor)]);
    return { ok: true, data: { summary, ...page } };
  } catch (error) {
    console.error('[reviews] list', error);
    return { ok: false, error: 'The reviews could not be loaded just now.' };
  }
}

/** Public: whether this person may write a review of the product, and if they already have, how it stands. */
export async function reviewEligibilityAction(raw: unknown): Promise<Result<ReviewEligibility>> {
  const productId = idOf(raw);
  if (productId === null) return { ok: false, error: 'That product could not be found.' };
  try {
    return { ok: true, data: await ReviewsService.eligibility(await currentReviewer(), productId) };
  } catch (error) {
    console.error('[reviews] eligibility', error);
    return { ok: false, error: 'We could not check that just now.' };
  }
}

/** A signed-in shopper writes (or rewrites) their review of a product they have received. It waits for approval before it is shown. */
export async function submitReviewAction(raw: unknown): Promise<Result<{ status: 'pending' }>> {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const productId = idOf(input.productId);
  if (productId === null) return { ok: false, error: 'That product could not be found.' };
  const reviewer = await currentReviewer();
  if (reviewer === null) return { ok: false, error: 'Please sign in to write a review.' };
  const parsed = parseReviewInput(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const h = await headers();
  for (const subject of [reviewer.key, clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for'))]) {
    const verdict = await getContainer().rateLimits.hit('review_submit', subject);
    if (!verdict.allowed) return { ok: false, error: waitMessage(verdict.retryAfterSeconds) };
  }
  try {
    await ReviewsService.submit(reviewer, productId, parsed.value);
    return { ok: true, data: { status: 'pending' } };
  } catch (error) {
    if (error instanceof SettingsError) return { ok: false, error: error.message };
    console.error('[reviews] submit', error);
    return { ok: false, error: 'Your review could not be saved. Please try again.' };
  }
}

// ── For the people who moderate ──────────────────────────────────────────

export interface ReviewQueuePage {
  rows: {
    id: string;
    productId: string;
    productName: string;
    productSlug: string;
    rating: number;
    title: string;
    body: string;
    reviewerName: string;
    verifiedPurchase: boolean;
    status: ReviewStatus;
    moderationNote: string;
    createdAt: string;
  }[];
  nextCursor: string | null;
  waiting: number;
}

const STATUSES: readonly ReviewStatus[] = ['pending', 'approved', 'rejected'];

export async function reviewQueueAction(raw: unknown): Promise<SettingsResult<ReviewQueuePage>> {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const status = STATUSES.find((value) => value === input.status) ?? 'pending';
  return runSetting('reviews:moderate', () =>
    ReviewsService.queue({ status, query: typeof input.query === 'string' ? input.query : '', cursor: typeof input.cursor === 'string' && input.cursor.length <= 600 ? input.cursor : null }),
  );
}

export async function moderateReviewAction(raw: unknown): Promise<SettingsResult<null>> {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const id = idOf(input.id);
  const decision = (['approve', 'reject', 'delete'] as const).find((value) => value === input.decision);
  return runSetting(
    'reviews:moderate',
    async ({ userId }) => {
      if (id === null || decision === undefined) throw new SettingsError('That review could not be found.');
      await ReviewsService.moderate({ id, decision, note: typeof input.note === 'string' ? input.note : '', actor: userId });
      return null;
    },
    { paths: ['/admin/reviews'] },
  );
}
