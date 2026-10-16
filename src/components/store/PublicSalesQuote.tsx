'use client';

import { useState } from 'react';
import { CheckCircle2, LoaderCircle } from 'lucide-react';
import { keyed } from '@/lib/keyed';
import { respondToPublicSalesQuoteAction, type getPublicSalesQuoteAction } from '@/server/domains/quotes/actions';
import { has } from '@/lib/values';

type SharedQuote = NonNullable<
  Awaited<ReturnType<typeof getPublicSalesQuoteAction>>
>;

export function PublicSalesQuote({ token, quote }: { token: string; quote: SharedQuote }) {
  const [response, setResponse] = useState<'accepted' | 'rejected' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const respond = async (accepted: boolean) => {
    try {
      setBusy(true);
      setError(null);
      const status = await respondToPublicSalesQuoteAction(token, accepted);
      setResponse(status);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'We could not record your response. Please contact the seller.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-canvas px-4 py-10 text-fg sm:py-16">
      <article className="mx-auto max-w-3xl overflow-hidden rounded-2xl border border-line bg-surface shadow-xl">
        <header className="border-b border-line bg-surface-raised p-6 sm:p-8">
          <p className="text-xs font-semibold tracking-widest text-fg-muted uppercase">Quotation</p>
          <h1 className="mt-2 text-2xl font-bold text-fg-strong">{quote.quoteNumber}</h1>
          <p className="mt-2 text-sm text-fg-muted">
            Prepared for {quote.customerName} by {quote.company.tradingName}
          </p>
          {quote.validUntil && (
            <p className="mt-1 text-xs text-fg-subtle">
              Valid until {new Date(quote.validUntil).toLocaleDateString()}
            </p>
          )}
        </header>
        <section className="p-6 sm:p-8">
          {response !== null ? (
            <div
              className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-emerald-900"
              role="status"
            >
              <CheckCircle2 className="mb-2 h-6 w-6" />
              <h2 className="font-semibold">Quote {response}</h2>
              <p className="mt-1 text-sm">
                {response === 'accepted'
                  ? 'Thank you. The seller has been notified and will follow up with your order.'
                  : 'Your response has been recorded. Contact the seller if you would like a revised quotation.'}
              </p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto rounded-xl border border-line">
                <table role="table" className="block md:table w-full text-left text-sm">
                  <thead role="rowgroup" className="hidden md:table-header-group bg-surface-raised text-xs text-fg-muted">
                    <tr role="row" className="block md:table-row">
                      <th role="columnheader" className="p-3">Description</th>
                      <th role="columnheader" className="p-3 text-right">Qty</th>
                      <th role="columnheader" className="p-3 text-right">Unit price</th>
                      <th role="columnheader" className="p-3 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody role="rowgroup" className="block md:table-row-group divide-y divide-line">
                    {keyed(quote.lines.filter((line) => !has(line.sectionId)), (l) => l.sku)
                      .map(({ item: line, key }) => (
                        <tr role="row" key={key} className="block md:table-row">
                          <td role="cell" className="before:mr-2 before:text-xs before:font-normal before:text-fg-muted before:content-[attr(data-label)] md:before:hidden block md:table-cell p-3" data-label="Description">
                            <div className="font-medium text-fg-strong">{line.description}</div>
                            <div className="text-xs text-fg-muted">{line.sku}</div>
                          </td>
                          <td role="cell" className="before:mr-2 before:text-xs before:font-normal before:text-fg-muted before:content-[attr(data-label)] md:before:hidden block md:table-cell p-3 md:text-right" data-label="Qty">{Number(line.quantity)}</td>
                          <td role="cell" className="before:mr-2 before:text-xs before:font-normal before:text-fg-muted before:content-[attr(data-label)] md:before:hidden block md:table-cell p-3 md:text-right" data-label="Unit price">
                            {quote.currency} {Number(line.unitPrice).toFixed(2)}
                          </td>
                          <td role="cell" className="before:mr-2 before:text-xs before:font-normal before:text-fg-muted before:content-[attr(data-label)] md:before:hidden block md:table-cell p-3 md:text-right font-medium" data-label="Amount">
                            {quote.currency} {Number(line.lineAmount).toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    {quote.sections.flatMap((section) => {
                      const sectionLines = quote.lines.filter(
                        (line) => line.sectionId === section.id,
                      );
                      const gross = sectionLines.reduce(
                        (sum, line) => sum + Number(line.lineAmount),
                        0,
                      );
                      return [
                        <tr role="row" key={`section-${section.id}`} className="block md:table-row bg-surface-raised">
                          <td role="cell" colSpan={4} className="block md:table-cell p-3">
                            <div className="flex justify-between gap-3">
                              <div>
                                <strong className="text-fg-strong">{section.title}</strong>
                                {has(section.description) && (
                                  <p className="text-xs text-fg-muted">{section.description}</p>
                                )}
                              </div>
                              <span className="font-semibold text-fg-strong">
                                {quote.currency} {gross.toFixed(2)}
                              </span>
                            </div>
                          </td>
                        </tr>,
                        ...keyed(section.showLines ? sectionLines : [], (l) => `${section.id}-${l.sku}`).map(({ item: line, key }) => (
                          <tr role="row" key={key} className="block md:table-row">
                            <td role="cell" className="before:mr-2 before:text-xs before:font-normal before:text-fg-muted before:content-[attr(data-label)] md:before:hidden block md:table-cell p-3 pl-8" data-label="Description">
                              <div className="font-medium text-fg-strong">{line.description}</div>
                              <div className="text-xs text-fg-muted">{line.sku}</div>
                            </td>
                            <td role="cell" className="before:mr-2 before:text-xs before:font-normal before:text-fg-muted before:content-[attr(data-label)] md:before:hidden block md:table-cell p-3 md:text-right" data-label="Qty">{Number(line.quantity)}</td>
                            <td role="cell" className="before:mr-2 before:text-xs before:font-normal before:text-fg-muted before:content-[attr(data-label)] md:before:hidden block md:table-cell p-3 md:text-right" data-label="Unit price">
                              {quote.currency} {Number(line.unitPrice).toFixed(2)}
                            </td>
                            <td role="cell" className="before:mr-2 before:text-xs before:font-normal before:text-fg-muted before:content-[attr(data-label)] md:before:hidden block md:table-cell p-3 md:text-right font-medium" data-label="Amount">
                              {quote.currency} {Number(line.lineAmount).toFixed(2)}
                            </td>
                          </tr>
                        )),
                      ];
                    })}
                  </tbody>
                </table>
              </div>
              <dl className="mt-5 ml-auto max-w-xs space-y-2 text-sm">
                <TotalRow label="Subtotal" value={quote.subtotal} currency={quote.currency} />
                <TotalRow label="Tax" value={quote.taxAmount} currency={quote.currency} />
                <TotalRow label="Shipping" value={quote.shippingFee} currency={quote.currency} />
                <div className="flex justify-between border-t border-line pt-3 text-base font-bold text-fg-strong">
                  <dt>Total</dt>
                  <dd>
                    {quote.currency} {Number(quote.totalAmount).toFixed(2)}
                  </dd>
                </div>
              </dl>
              {has(quote.publicNotes) && (
                <p className="mt-6 rounded-lg bg-surface-raised p-4 text-sm whitespace-pre-wrap text-fg">
                  {quote.publicNotes}
                </p>
              )}
              {quote.showBillingAddress && (
                <div className="mt-5 rounded-xl border border-line p-4">
                  <h2 className="text-sm font-semibold text-fg-strong">Bill to</h2>
                  <p className="mt-1 text-sm text-fg-muted">{quote.customerName}</p>
                  <p className="text-sm text-fg-muted">
                    {[
                      quote.billingAddress.street,
                      quote.billingAddress.city,
                      quote.billingAddress.countyOrState,
                      quote.billingAddress.postalCode,
                      quote.billingAddress.country,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  </p>
                </div>
              )}
              {has(quote.paymentDetails) && (
                <div className="mt-5 rounded-xl border border-line p-4">
                  <h2 className="text-sm font-semibold text-fg-strong">Payment details</h2>
                  <p className="mt-1 text-sm whitespace-pre-wrap text-fg-muted">
                    {quote.paymentDetails}
                  </p>
                </div>
              )}
              {has(quote.paymentTerms) && (
                <div className="mt-4 rounded-xl border border-line p-4">
                  <h2 className="text-sm font-semibold text-fg-strong">Payment terms</h2>
                  <p className="mt-1 text-sm whitespace-pre-wrap text-fg-muted">
                    {quote.paymentTerms}
                  </p>
                </div>
              )}
              {has(quote.termsAndConditions) && (
                <div className="mt-4 rounded-xl border border-line p-4">
                  <h2 className="text-sm font-semibold text-fg-strong">Terms and conditions</h2>
                  <p className="mt-1 text-sm whitespace-pre-wrap text-fg-muted">
                    {quote.termsAndConditions}
                  </p>
                </div>
              )}
              {has(error) && (
                <p
                  className="mt-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800"
                  role="alert"
                >
                  {error}
                </p>
              )}
              <div className="mt-8 flex flex-col justify-end gap-3 sm:flex-row">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void respond(false)}
                  className="rounded-lg border border-line-strong px-5 py-3 text-sm font-semibold text-fg hover:bg-hover disabled:opacity-50"
                >
                  Decline quote
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void respond(true)}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}Accept quote
                </button>
              </div>
            </>
          )}
        </section>
        <footer className="border-t border-line px-6 py-4 text-center text-xs text-fg-subtle">
          Questions? Contact {quote.company.email}
          {has(quote.company.phone) ? ` · ${quote.company.phone}` : ''}
        </footer>
      </article>
    </main>
  );
}

function TotalRow({
  label,
  value,
  currency,
}: {
  label: string;
  value: string | number;
  currency: string;
}) {
  return (
    <div className="flex justify-between text-fg-muted">
      <dt>{label}</dt>
      <dd>
        {currency} {Number(value).toFixed(2)}
      </dd>
    </div>
  );
}
