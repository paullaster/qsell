import { notFound } from 'next/navigation';
import { PublicSalesQuote } from '@/components/store/PublicSalesQuote';
import { getPublicSalesQuoteAction } from '@/server/domains/quotes/actions';

export default async function PublicQuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const quote = await getPublicSalesQuoteAction(token);
  if (!quote) notFound();
  return <PublicSalesQuote token={token} quote={quote} />;
}
