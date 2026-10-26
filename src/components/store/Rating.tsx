import { Star } from 'lucide-react';

/** Stars and the number of reviews, shown only when there are reviews: a row of "0.0 (0)" tells the shopper nothing. */
export function Rating({ rating, reviewCount }: { rating: number; reviewCount: number }) {
  if (reviewCount <= 0) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-500" aria-hidden="true" />
      <span className="font-semibold text-fg-strong">
        {rating.toFixed(1)}
        <span className="sr-only"> out of 5 stars</span>
      </span>
      <span className="text-fg-muted">
        ({reviewCount}
        <span className="sr-only"> {reviewCount === 1 ? 'review' : 'reviews'}</span>)
      </span>
    </span>
  );
}
