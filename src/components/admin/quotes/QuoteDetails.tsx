'use client';

import { BadgeCheck, Ban, Check, FilePlus2, ShoppingCart, Files, X } from 'lucide-react';

import type { SalesQuote } from '@/server/domains/quotes/service';

import { Modal } from '@/components/ui/Modal';
import { hasText, joinPresent, money, orElse } from '@/lib/quote-display';
import { statusText } from '@/lib/quote-statuses';

export function QuoteDetails({
  quote,
  canApprove,
  canDelete,
  canRevise,
  onTemplate,
  busy,
  onClose,
  onApprove,
  onResubmit,
  onAccept,
  onReject,
  onCancel,
  onRevise,
  onConvert,
  onPreview,
}: {
  quote: SalesQuote;
  canApprove: boolean;
  canDelete: boolean;
  canRevise: boolean;
  /** Make a template from this quote; offered to anyone who may create quotes. */
  onTemplate: () => void;
  busy: boolean;
  onClose: () => void;
  onApprove: () => void;
  onResubmit: () => void;
  onAccept: () => void;
  onReject: () => void;
  onCancel: () => void;
  onRevise: () => void;
  onConvert: () => void;
  onPreview: () => void;
}) {
  const floorMiss = Number(quote.grossMarginPercent) < Number(quote.minimumMarginPercent);
  return (
    <Modal title={`${quote.quoteNumber} · ${statusText(quote.status)}`} onClose={onClose} wide>
      <div className="space-y-5">
        <section className="grid gap-3 sm:grid-cols-3">
          <Summary
            label="Customer"
            value={quote.customerName}
            detail={quote.customerEmail ?? undefined}
          />
          <Summary
            label="Quote total"
            value={money(Number(quote.totalAmount), quote.currency)}
            detail={`Valid until ${quote.validUntil ? new Date(quote.validUntil).toLocaleDateString() : 'no expiry'}`}
          />
          <Summary
            label="Internal gross margin"
            value={`${Number(quote.grossMarginPercent).toFixed(1)}%`}
            detail={`${money(Number(quote.grossProfit), quote.currency)} gross profit · floor ${Number(quote.minimumMarginPercent).toFixed(1)}%`}
            danger={floorMiss}
          />
        </section>
        {quote.showBillingAddress &&
          Object.values(quote.billingAddress).some((value) => value.trim().length > 0) && (
            <Summary
              label="Bill to"
              value={quote.customerName}
              detail={[
                quote.billingAddress.street,
                quote.billingAddress.city,
                quote.billingAddress.countyOrState,
                quote.billingAddress.postalCode,
                quote.billingAddress.country,
              ]
                .filter(Boolean)
                .join(', ')}
            />
          )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Summary
            label="Ship to (internal quote detail)"
            value={quote.customerName}
            detail={orElse(
              joinPresent(
                [
                  quote.deliveryAddress.street,
                  quote.deliveryAddress.city,
                  quote.deliveryAddress.countyOrState,
                  quote.deliveryAddress.postalCode,
                  quote.deliveryAddress.country,
                ],
                ', ',
              ),
              'No delivery address saved',
            )}
          />
          <Summary
            label="Payment and terms"
            value={quote.paymentMethod.replaceAll('_', ' ')}
            detail={orElse(
              joinPresent([quote.paymentTerms, quote.paymentDetails], ' · '),
              'No payment details configured',
            )}
          />
        </div>
        {hasText(quote.termsAndConditions) && (
          <div className="rounded-xl border border-line bg-surface p-4">
            <h3 className="font-semibold text-fg-strong">Terms and conditions</h3>
            <p className="mt-2 text-sm whitespace-pre-wrap text-fg-muted">
              {quote.termsAndConditions}
            </p>
          </div>
        )}
        <section className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[600px] text-left text-sm">
            <thead className="bg-surface text-xs text-fg-muted">
              <tr>
                <th className="p-3">Item</th>
                <th className="p-3 text-right">Qty</th>
                <th className="p-3 text-right">Price</th>
                <th className="p-3 text-right">Cost (internal)</th>
                <th className="p-3 text-right">Margin (internal)</th>
                <th className="p-3 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {quote.lines
                .filter((line) => line.sectionId === null)
                .map((line) => {
                  const revenue = Number(line.netAmount);
                  const profit = revenue - Number(line.costAmount);
                  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
                  return (
                    <tr key={line.id}>
                      <td className="p-3">
                        <div className="font-medium text-fg-strong">{line.description}</div>
                        <div className="text-xs text-fg-muted">
                          {line.sku} · tax {Number(line.taxRate)}%
                        </div>
                      </td>
                      <td className="p-3 text-right">{Number(line.quantity)}</td>
                      <td className="p-3 text-right">
                        {money(Number(line.unitPrice), quote.currency)}
                      </td>
                      <td className="p-3 text-right text-fg-muted">
                        {money(Number(line.costAmount), quote.currency)}
                      </td>
                      <td className="p-3 text-right font-semibold">{margin.toFixed(1)}%</td>
                      <td className="p-3 text-right font-semibold text-fg-strong">
                        {money(Number(line.lineAmount), quote.currency)}
                      </td>
                    </tr>
                  );
                })}
              {quote.sections.flatMap((section) => {
                const sectionLines = quote.lines.filter((line) => line.sectionId === section.id);
                const sectionGross = sectionLines.reduce(
                  (sum, line) => sum + Number(line.lineAmount),
                  0,
                );
                return [
                  <tr key={`section-${section.id}`} className="bg-surface-raised">
                    <td colSpan={6} className="p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <strong className="text-fg-strong">{section.title}</strong>
                          {hasText(section.description) && (
                            <p className="text-xs text-fg-muted">{section.description}</p>
                          )}
                        </div>
                        <span className="font-mono font-bold text-fg-strong">
                          Section gross total {money(sectionGross, quote.currency)}
                        </span>
                      </div>
                    </td>
                  </tr>,
                  ...sectionLines.map((line) => {
                    const revenue = Number(line.netAmount);
                    const profit = revenue - Number(line.costAmount);
                    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
                    return (
                      <tr key={line.id}>
                        <td className="p-3">
                          <div className="font-medium text-fg-strong">{line.description}</div>
                          <div className="text-xs text-fg-muted">
                            {line.sku} · tax {Number(line.taxRate)}%
                          </div>
                        </td>
                        <td className="p-3 text-right">{Number(line.quantity)}</td>
                        <td className="p-3 text-right">
                          {money(Number(line.unitPrice), quote.currency)}
                        </td>
                        <td className="p-3 text-right text-fg-muted">
                          {money(Number(line.costAmount), quote.currency)}
                        </td>
                        <td
                          className={`p-3 text-right font-semibold ${margin < Number(quote.minimumMarginPercent) ? 'text-red-700' : 'text-emerald-700'}`}
                        >
                          {margin.toFixed(1)}%
                        </td>
                        <td className="p-3 text-right font-semibold text-fg-strong">
                          {money(Number(line.lineAmount), quote.currency)}
                        </td>
                      </tr>
                    );
                  }),
                ];
              })}
            </tbody>
          </table>
        </section>
        {hasText(quote.internalNotes) && (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
            <strong>Internal:</strong> {quote.internalNotes}
          </p>
        )}
        {hasText(quote.publicNotes) && (
          <p className="rounded-lg border border-line bg-surface p-3 text-sm text-fg">
            <strong>Customer note:</strong> {quote.publicNotes}
          </p>
        )}
        <section className="rounded-xl border border-line p-4">
          <h3 className="mb-3 font-semibold text-fg-strong">Document history</h3>
          <ol className="space-y-2">
            {quote.events.map((event) => (
              <li key={event.id} className="flex justify-between gap-3 text-sm">
                <span className="text-fg-strong capitalize">
                  {event.eventType.replaceAll('_', ' ')}
                </span>
                <time className="text-xs text-fg-muted">
                  {new Date(event.createdAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ol>
        </section>
        <footer className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
          <ActionButton
            onClick={onPreview}
            disabled={busy}
            icon={<FilePlus2 className="h-4 w-4" />}
          >
            Preview customer PDF
          </ActionButton>
          {quote.approvalManagedBy === 'workflow' && quote.approvalStatus === 'draft' && (
            <ActionButton
              onClick={onResubmit}
              disabled={busy}
              icon={<BadgeCheck className="h-4 w-4" />}
            >
              Send for approval again
            </ActionButton>
          )}
          {quote.status === 'pending_approval' &&
            canApprove &&
            quote.approvalManagedBy !== 'workflow' && (
              <ActionButton
                onClick={onApprove}
                disabled={busy}
                icon={<BadgeCheck className="h-4 w-4" />}
              >
                Approve
              </ActionButton>
            )}
          {quote.status === 'sent' && canApprove && (
            <>
              <ActionButton onClick={onAccept} disabled={busy} icon={<Check className="h-4 w-4" />}>
                Mark accepted
              </ActionButton>
              <ActionButton onClick={onReject} disabled={busy} icon={<Ban className="h-4 w-4" />}>
                Mark rejected
              </ActionButton>
            </>
          )}
          {quote.status === 'accepted' && canApprove && (
            <ActionButton
              onClick={onConvert}
              disabled={busy}
              icon={<ShoppingCart className="h-4 w-4" />}
            >
              Convert to order
            </ActionButton>
          )}
          {canRevise && (
            <ActionButton onClick={onTemplate} disabled={busy} icon={<Files className="h-4 w-4" />}>
              Create template from this quote
            </ActionButton>
          )}
          {canRevise && !['converted', 'cancelled'].includes(quote.status) && (
            <ActionButton
              onClick={onRevise}
              disabled={busy}
              icon={<FilePlus2 className="h-4 w-4" />}
            >
              Create revision
            </ActionButton>
          )}
          {canDelete &&
            !['converted', 'cancelled', 'rejected', 'expired'].includes(quote.status) && (
              <ActionButton onClick={onCancel} disabled={busy} icon={<Ban className="h-4 w-4" />}>
                Cancel quote
              </ActionButton>
            )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-4 py-2 text-sm text-fg"
          >
            Close
          </button>
        </footer>
      </div>
    </Modal>
  );
}

function Summary({
  label,
  value,
  detail,
  danger,
}: {
  label: string;
  value: string;
  detail?: string;
  danger?: boolean;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="text-xs text-fg-muted">{label}</div>
      <div className={`mt-1 font-semibold ${danger === true ? 'text-red-700' : 'text-fg-strong'}`}>
        {value}
      </div>
      {hasText(detail) && <div className="mt-1 text-xs text-fg-subtle">{detail}</div>}
    </div>
  );
}

function ActionButton({
  children,
  icon,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm font-medium text-fg hover:bg-hover disabled:opacity-50"
    >
      {icon}
      {children}
    </button>
  );
}

export function PdfPreview({ base64, onClose }: { base64: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-backdrop/80 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Customer quote PDF preview"
        className="flex h-[94dvh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-line p-3">
          <h2 className="font-semibold text-fg-strong">Customer quotation preview</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="rounded-lg p-2 text-fg-muted hover:bg-hover"
          >
            <X className="h-5 w-5" />
          </button>
        </header>
        <iframe
          title="Quote PDF preview"
          src={`data:application/pdf;base64,${base64}`}
          className="min-h-0 flex-1 bg-white"
        />
      </section>
    </div>
  );
}
