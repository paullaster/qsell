import { notFound } from 'next/navigation';
import { BusinessTimeZoneProvider } from '@/components/business-time';
import { getContainer } from '@/server/di/container';
import { PublicSalesQuote } from '@/components/store/PublicSalesQuote';
import { getPublicSalesQuoteAction } from '@/server/domains/quotes/actions';

export default async function PublicQuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [quote, company] = await Promise.all([getPublicSalesQuoteAction(token), getContainer().companySettings.ensureSeeded()]);
  if (!quote) notFound();
  return (
    <BusinessTimeZoneProvider timeZone={company.timezone}>
      <PublicSalesQuote token={token} quote={quote} />
    </BusinessTimeZoneProvider>
  );
}
