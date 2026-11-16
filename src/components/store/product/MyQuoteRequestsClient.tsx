'use client';

import { use } from 'react';
import Link from 'next/link';
import { SignInPrompt } from '@/components/store/account/SignInPrompt';
import { LoadFailed } from '@/components/ui/screen-kit';
import { useStore } from '@/components/store/StoreContext';
import { QUOTE_REQUEST_STATE_WORDS, type QuoteRequestState } from '@/server/domains/pricing/domain/package-quote-state';
import type { myQuoteRequestsAction } from '@/server/domains/pricing/package-quote-actions';

const TONE: Record<QuoteRequestState, string> = {
  preparing: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  sent: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  accepted: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  declined: 'bg-red-500/15 text-red-700 dark:text-red-300',
  expired: 'bg-zinc-500/15 text-zinc-700 dark:text-zinc-300',
  cancelled: 'bg-red-500/15 text-red-700 dark:text-red-300',
};

/** The quotes the signed-in shopper asked for: what each is, where it stands in plain words, and the order once accepted. */
export function MyQuoteRequestsClient({ requests }: { requests: ReturnType<typeof myQuoteRequestsAction> }) {
  const answer = use(requests);
  const { money } = useStore();
  if (!answer.ok) {
    if ('signIn' in answer) return <SignInPrompt what="your quote requests" />;
    return <LoadFailed error={answer.error} />;
  }
  if (answer.data.length === 0) {
    return (
      <p className="rounded-xl border border-line bg-surface-raised p-6 text-sm text-fg-muted" data-testid="quotes-empty">
        You have not asked for a quote yet. Open a package in the shop and press <strong>Request a quote</strong>.
      </p>
    );
  }
  return (
    <ul className="space-y-3" aria-label="My quote requests" data-testid="my-quote-requests">
      {answer.data.map((q) => (
        <li key={q.id} className="space-y-2 rounded-xl border border-line bg-surface-raised p-4" data-testid="my-quote-request">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold break-words text-fg-strong">Quote {q.quoteNumber}</p>
              <p className="text-sm break-words text-fg-muted">
                {q.lines.length === 0 ? 'Your request' : q.lines.join(', ')}
                {q.neededOn === null ? '' : ` · needed on ${q.neededOn}`}
              </p>
            </div>
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${TONE[q.state]}`}>{QUOTE_REQUEST_STATE_WORDS[q.state].label}</span>
          </div>
          <p className="text-sm text-fg-muted">{QUOTE_REQUEST_STATE_WORDS[q.state].hint}</p>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-mono font-semibold text-fg-strong">{money(q.total)}</span>
            {q.orderId === null ? null : (
              <Link href={`/profile/orders/${q.orderId}`} className="font-semibold text-indigo-600 underline dark:text-indigo-300">
                Order {q.orderNumber ?? ''}
              </Link>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
