'use client';

import { use, useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { BadgeCheck, Star } from 'lucide-react';
import { productReviewsAction, reviewEligibilityAction, submitReviewAction } from '@/server/domains/reviews/actions';
import { REVIEW_LIMITS, type PublicReview, type RatingSummary, type ReviewEligibility } from '@/lib/reviews';
import { StarInput } from '@/components/store/product/StarInput';

interface Loaded {
  summary: RatingSummary;
  reviews: PublicReview[];
  nextCursor: string | null;
}

const inputClass = 'min-h-11 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40';

function Stars({ value }: { value: number }) {
  return (
    <span className="inline-flex" role="img" aria-label={`${String(value)} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => <Star key={n} className={`h-4 w-4 ${n <= Math.round(value) ? 'fill-amber-400 text-amber-500' : 'text-fg-faint'}`} aria-hidden="true" />)}
    </span>
  );
}

function Summary({ summary }: { summary: RatingSummary }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <div className="text-center sm:text-left">
        <p className="text-4xl font-bold text-fg-strong">{summary.average.toFixed(1)}</p>
        <Stars value={summary.average} />
        <p className="mt-1 text-sm text-fg-muted">{summary.count} {summary.count === 1 ? 'review' : 'reviews'}</p>
      </div>
      <ul className="w-full max-w-xs space-y-1.5" aria-label="Reviews by rating">
        {summary.distribution.map((row) => (
          <li key={row.stars} className="flex items-center gap-2 text-sm text-fg-muted">
            <span className="w-12 shrink-0">{row.stars} stars</span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken"><span className="block h-full rounded-full bg-amber-400" style={{ width: `${String(summary.count === 0 ? 0 : Math.round((row.count / summary.count) * 100))}%` }} /></span>
            <span className="w-6 shrink-0 text-right">{row.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewForm({ productId, again, onDone }: { productId: string; again: boolean; onDone: () => void }) {
  const id = useId();
  const [rating, setRating] = useState(0);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await submitReviewAction({ productId, rating, title, body });
      if (!result.ok) setError(result.error);
      else onDone();
    } catch {
      setError('We could not reach the shop. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="space-y-3 rounded-xl border border-line bg-surface p-4" aria-label="Write a review">
      <h3 className="text-base font-semibold text-fg-strong">{again ? 'Write your review again' : 'Write a review'}</h3>
      <StarInput value={rating} onChange={setRating} />
      <div>
        <label htmlFor={`${id}-title`} className="mb-1 block text-sm font-medium text-fg">Title (optional)</label>
        <input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={REVIEW_LIMITS.titleMax} className={inputClass} />
      </div>
      <div>
        <label htmlFor={`${id}-body`} className="mb-1 block text-sm font-medium text-fg">Your review</label>
        <textarea id={`${id}-body`} value={body} onChange={(e) => setBody(e.target.value)} rows={5} maxLength={REVIEW_LIMITS.bodyMax} className={inputClass} />
        <p className="mt-1 text-xs text-fg-muted">{body.length} / {REVIEW_LIMITS.bodyMax}. Reviews are checked before they appear. Please keep web links out of them.</p>
      </div>
      {error === null ? null : <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">{error}</p>}
      <button type="submit" disabled={busy} className="min-h-11 cursor-pointer rounded-lg bg-indigo-600 px-5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">{busy ? 'Sending…' : 'Send review'}</button>
    </form>
  );
}

function Invitation({ productId, slug }: { productId: string; slug: string }) {
  const [state, setState] = useState<ReviewEligibility | 'loading' | 'sent'>('loading');
  const [rewrite, setRewrite] = useState(false);
  useEffect(() => {
    let cancelled = false;
    reviewEligibilityAction(productId)
      .then((result) => {
        if (!cancelled) setState(result.ok ? result.data : { state: 'not_purchased' });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [productId]);
  if (state === 'loading') return null;
  if (state === 'sent') return <p role="status" className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">Thank you. Your review will appear once it has been checked.</p>;
  if (state.state === 'sign_in') {
    return <p className="text-sm text-fg-muted"><Link href={`/login?callbackUrl=${encodeURIComponent(`/product/${slug}`)}`} className="font-semibold text-indigo-600 underline dark:text-indigo-400">Sign in</Link> to review this product if you have bought it.</p>;
  }
  if (state.state === 'not_purchased') return <p className="text-sm text-fg-muted">Reviews come from people who have received this product.</p>;
  if (state.state === 'can_review' || rewrite) return <ReviewForm productId={productId} again={state.state === 'reviewed'} onDone={() => { setRewrite(false); setState('sent'); }} />;
  const note = state.status === 'rejected' && state.note !== '' ? ` The reason given: ${state.note}` : '';
  const words = { pending: 'Your review is waiting to be checked.', approved: 'Your review is published. Thank you.', rejected: `Your review was not published.${note}` }[state.status];
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4 text-sm text-fg">
      <p role="status">{words}</p>
      <button type="button" onClick={() => setRewrite(true)} className="min-h-11 cursor-pointer rounded-lg border border-line-strong px-4 text-sm font-semibold text-fg-strong hover:bg-hover">Write it again</button>
    </div>
  );
}

/** What buyers said about a product: the spread of ratings, the reviews a page at a time, and the way to add yours. */
export function ProductReviews({ productId, slug, firstPage }: { productId: string; slug: string; firstPage: Promise<{ ok: true; data: Loaded } | { ok: false; error: string }> }) {
  const first = use(firstPage);
  const [more, setMore] = useState<PublicReview[]>([]);
  const [loadedCursor, setLoadedCursor] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!first.ok) return <p role="alert" className="text-sm text-fg-muted">{first.error}</p>;
  const nextCursor = loadedCursor === undefined ? first.data.nextCursor : loadedCursor;
  const reviews = [...first.data.reviews, ...more];
  const showMore = async () => {
    if (nextCursor === null || loading) return;
    setLoading(true);
    setFailed(false);
    try {
      const page = await productReviewsAction({ productId, cursor: nextCursor });
      if (!page.ok) throw new Error(page.error);
      setMore((current) => [...current, ...page.data.reviews]);
      setLoadedCursor(page.data.nextCursor);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="space-y-5">
      {first.data.summary.count === 0 ? <p className="text-sm text-fg-muted">There are no reviews yet.</p> : <Summary summary={first.data.summary} />}
      <Invitation productId={productId} slug={slug} />
      {reviews.length === 0 ? null : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {reviews.map((review) => (
            <li key={review.id} className="space-y-1.5 p-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Stars value={review.rating} />
                {review.title === '' ? null : <h3 className="text-sm font-semibold text-fg-strong">{review.title}</h3>}
              </div>
              <p className="text-sm whitespace-pre-line text-fg">{review.body}</p>
              <p className="flex flex-wrap items-center gap-x-3 text-xs text-fg-muted">
                <span>{review.reviewerName}</span>
                {review.verifiedPurchase ? <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400"><BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />Verified purchase</span> : null}
                <time dateTime={review.createdAt}>{review.createdAt.slice(0, 10)}</time>
              </p>
            </li>
          ))}
        </ul>
      )}
      {failed ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">Could not load more reviews. Please try again.</p> : null}
      {nextCursor === null ? null : (
        <button type="button" onClick={() => void showMore()} disabled={loading} className="min-h-11 cursor-pointer rounded-lg border border-line-strong bg-surface-raised px-6 text-sm font-semibold text-fg-strong hover:bg-hover disabled:opacity-50">{loading ? 'Loading…' : 'Show more reviews'}</button>
      )}
    </div>
  );
}
