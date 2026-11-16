import { getContainer } from '@/server/di/container';
import { layout } from '@/server/domains/auth/emails';
import { resolvePublicBaseUrl } from '@/server/domains/auth/account-service';
import { addressing } from '@/server/domains/email-routing/email-routes';
import { isQuoteRequestEmailKind, quoteRequestEmailContent } from '@/lib/quote-request-emails';
import { formatCartAmount, resolveBaseCurrency } from '@/lib/cartMoney';
import { listCurrenciesAction } from '@/server/domains/currencies/actions';
import { orElse } from '@/lib/values';
import { storedWords } from '@/server/domains/pricing/domain/package-shop';
import { SalesQuoteService } from './service';

/** What a quote line was for, in words: a package's choices when it is one. */
const asked = (line: { description: string; priceTrace: { quotedAsPackage?: { name: string; picks: Parameters<typeof storedWords>[0] } } | null }): string => {
  const kept = line.priceTrace?.quotedAsPackage;
  return kept === undefined ? line.description : `${kept.name}: ${storedWords(kept.picks)}`;
};

/**
 * Writes about a quote a shopper asked for on the web shop: a confirmation to the shopper, and an alert to the company's own address so
 * the request is seen. The job that calls this is retried by the worker, so a mail server that is down only delays it; one job for each
 * quote and kind, so a repeat sends one mail. Returns what happened, for the log.
 */
export async function sendQuoteRequestEmail(quoteId: string, kind: string): Promise<'sent' | 'no_address' | 'off' | 'gone'> {
  if (!isQuoteRequestEmailKind(kind)) return 'gone';
  const quote = await new SalesQuoteService().get(quoteId);
  // Only a quote the shopper asked for is theirs to be written to about; staff quotes have their own send.
  if (quote?.source !== 'shop') return 'gone';
  const c = getContainer();
  const company = await c.companySettings.ensureSeeded();
  // Who is written to, copied and answered by is the company's own setting for this point (Settings, Email routing).
  const route = await c.emailRoutes.resolve(company.id, kind === 'shopper' ? 'shop_quote_request_customer' : 'shop_quote_request_staff', { customerEmail: quote.customerEmail });
  if (!route.send) return route.reason === 'This email is switched off.' ? 'off' : 'no_address';
  const base = resolvePublicBaseUrl(company.publicBaseUrl);
  let currency: ReturnType<typeof resolveBaseCurrency> = null;
  try {
    currency = resolveBaseCurrency(await listCurrenciesAction());
  } catch {
    currency = null;
  }
  const money = (amount: number): string => formatCartAmount(amount, currency);
  const tradingName = orElse(company.tradingName, 'our shop');
  const message = /The customer wrote: (.*)$/s.exec(quote.internalNotes ?? '')?.[1] ?? '';
  const content = quoteRequestEmailContent(kind, {
    tradingName,
    quoteNumber: quote.quoteNumber,
    customerName: quote.customerName,
    customerEmail: quote.customerEmail,
    customerPhone: quote.customerPhone,
    lines: quote.lines.filter((l) => !l.isGift).map((l) => `${String(Number(l.quantity))} × ${asked(l)}`),
    neededOn: quote.neededOn ?? '',
    message,
    total: money(Number(quote.totalAmount)),
  });
  const actionUrl = kind === 'shopper' ? `${base}/` : `${base}/admin/quotes`;
  const footer = kind === 'shopper' ? `You are receiving this because a quote was requested for ${quote.quoteNumber} on ${tradingName}'s web shop.` : 'You are receiving this because a quote was requested on your web shop.';
  const html = layout({ heading: content.heading, greeting: content.greeting, body: content.body, cta: content.cta, actionUrl, footer, details: content.details });
  const text = `${content.heading}\n\n${content.greeting}\n\n${content.body}\n\n${content.details.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${content.cta}: ${actionUrl}\n\n${footer}`;
  await c.email.send({ ...addressing(route), subject: content.subject, html, text, sender: { name: tradingName, address: company.email } });
  return 'sent';
}
