import { isRecord } from '@/lib/values';

export const REVIEW_LIMITS = { titleMax: 100, bodyMin: 10, bodyMax: 2000 } as const;

export interface ReviewInput {
  rating: number;
  title: string;
  body: string;
}

type Parsed = { ok: true; value: ReviewInput } | { ok: false; error: string };

// eslint-disable-next-line no-control-regex -- the point is to strip them
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const LINK = /(?:https?:\/\/|www\.)\S+/i;

const clean = (value: unknown): string => (typeof value === 'string' ? value.replace(CONTROL, ' ').replace(/\r\n?/g, '\n').trim() : '');

/** Reads a review from the browser. The server checks it again here: nothing about who wrote it or what it says is taken on trust. */
export function parseReviewInput(raw: unknown): Parsed {
  if (!isRecord(raw)) return { ok: false, error: 'Your review could not be read. Please try again.' };
  const rating = raw.rating;
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, error: 'Please choose a rating from 1 to 5 stars.' };
  const title = clean(raw.title);
  const body = clean(raw.body);
  if (title.length > REVIEW_LIMITS.titleMax) return { ok: false, error: `Please keep the title to ${String(REVIEW_LIMITS.titleMax)} characters.` };
  if (body.length < REVIEW_LIMITS.bodyMin) return { ok: false, error: `Please write at least ${String(REVIEW_LIMITS.bodyMin)} characters about the product.` };
  if (body.length > REVIEW_LIMITS.bodyMax) return { ok: false, error: `Please keep your review to ${String(REVIEW_LIMITS.bodyMax)} characters.` };
  if (LINK.test(title) || LINK.test(body)) return { ok: false, error: 'Please do not include web links in a review.' };
  return { ok: true, value: { rating, title, body } };
}

/** How a reviewer is shown to others: a first name and the initial of the last, never an email address. */
export function reviewerDisplayName(name: string): string {
  const words = name.split(/\s+/).filter((word) => word !== '' && !word.includes('@'));
  const first = words[0];
  if (first === undefined) return 'Customer';
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  const initial = last === undefined ? '' : ` ${(last.charAt(0).toUpperCase())}.`;
  return `${first.slice(0, 30)}${initial}`;
}

export interface RatingSummary {
  average: number;
  count: number;
  /** Reviews per star, 5 first. */
  distribution: { stars: number; count: number }[];
}

/** The average (one decimal), the count and the spread of approved ratings. */
export function ratingSummary(perStar: readonly { rating: number; count: number }[]): RatingSummary {
  const distribution = [5, 4, 3, 2, 1].map((stars) => ({ stars, count: perStar.find((row) => row.rating === stars)?.count ?? 0 }));
  const count = distribution.reduce((sum, row) => sum + row.count, 0);
  const total = distribution.reduce((sum, row) => sum + row.stars * row.count, 0);
  return { average: count === 0 ? 0 : Math.round((total / count) * 10) / 10, count, distribution };
}

export type ReviewEligibility =
  | { state: 'sign_in' }
  | { state: 'not_purchased' }
  | { state: 'can_review' }
  | { state: 'reviewed'; status: 'pending' | 'approved' | 'rejected'; note: string };

export interface PublicReview {
  id: string;
  rating: number;
  title: string;
  body: string;
  reviewerName: string;
  verifiedPurchase: boolean;
  createdAt: string;
}
