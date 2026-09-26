'use client';

import { useMemo, useState, useTransition } from 'react';
import {
  ArrowDownCircle,
  ArrowUpCircle,
  CheckCircle2,
  RefreshCw,
  Scale,
  ToggleLeft,
} from 'lucide-react';
import type { PaymentCallbackEventRow } from '@/server/db/drizzle/schema';
import type {
  MissingInvoiceDebit,
  MissingPaymentCredit,
} from '@/server/domains/transactions/reconcile-service';
import {
  postInvoiceLedgerDebitAction,
  postPaymentLedgerCreditAction,
} from '@/server/domains/transactions/reconcile-actions';
import { classifyCallbackEventAction } from '@/server/domains/payments/classify-actions';

const amountFormat = new Intl.NumberFormat('en-KE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function money(amount: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;
  return amountFormat.format(value);
}

const rowClass = 'border-t border-line';

function PrimaryButton({
  label,
  pendingLabel = 'Working…',
  pending,
  disabled,
  onClick,
}: {
  label: string;
  pendingLabel?: string;
  pending: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled || pending}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
    >
      {pending ? (
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <CheckCircle2 className="h-3.5 w-3.5" />
      )}
      {pending ? pendingLabel : label}
    </button>
  );
}

export function AdminTransactionReconcile({
  invoiceDebits: initialDebits,
  paymentCredits: initialCredits,
  callbacks: initialCallbacks,
}: {
  invoiceDebits: MissingInvoiceDebit[];
  paymentCredits: MissingPaymentCredit[];
  callbacks: PaymentCallbackEventRow[];
}) {
  const [debits, setDebits] = useState(initialDebits);
  const [credits, setCredits] = useState(initialCredits);
  const [callbacks, setCallbacks] = useState(initialCallbacks);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const totals = useMemo(() => {
    const debit = debits.reduce((sum, row) => sum + Number(row.amount), 0);
    const credit = credits.reduce((sum, row) => sum + Number(row.amount), 0);
    return { debit, credit };
  }, [debits, credits]);

  const postDebit = (orderId: string) => {
    setError(null);
    startTransition(async () => {
      try {
        setDebits(await postInvoiceLedgerDebitAction(orderId));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to post the debit.');
      }
    });
  };

  const postCredit = (source: 'customer_ledger' | 'gateway_attempt', id: string) => {
    setError(null);
    startTransition(async () => {
      try {
        setCredits(await postPaymentLedgerCreditAction(source, id));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to post the credit.');
      }
    });
  };

  const classify = (eventId: string) => {
    setError(null);
    startTransition(async () => {
      try {
        const updated = await classifyCallbackEventAction(eventId);
        setCallbacks((prev) => {
          const without = prev.filter((row) => row.id !== eventId);
          const stillNeedsReview =
            updated.outcome === 'unclassified' || updated.processingStatus === 'error';
          return stillNeedsReview ? [...without, updated] : without;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to classify the callback.');
      }
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-bold text-fg-strong">
          <Scale className="h-5 w-5 text-indigo-400" /> Reconcile
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-fg-muted">
          Documents that settled but never posted to the transactions ledger. Review and post by
          hand — nothing here retries automatically, and posting a document twice is a no-op.
        </p>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-800 bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
        </div>
      ) : null}

      <dl className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface-sunken/50 p-4">
          <dt className="text-xs tracking-wide text-fg-subtle uppercase">
            Unposted invoice debits
          </dt>
          <dd className="mt-1 text-xl font-semibold text-amber-700">
            {debits.length} documents · {money(totals.debit.toFixed(2))}
          </dd>
        </div>
        <div className="rounded-xl border border-line bg-surface-sunken/50 p-4">
          <dt className="text-xs tracking-wide text-fg-subtle uppercase">
            Unposted payment credits
          </dt>
          <dd className="mt-1 text-xl font-semibold text-emerald-700">
            {credits.length} documents · {money(totals.credit.toFixed(2))}
          </dd>
        </div>
      </dl>

      <section className="overflow-hidden rounded-xl border border-line">
        <div className="border-b border-line bg-surface-sunken/80 px-4 py-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-fg-strong">
            <ArrowUpCircle className="h-4 w-4 text-amber-600" /> Sales missing an invoice debit
          </h3>
          <p className="mt-0.5 text-xs text-fg-subtle">
            Paid or open orders whose debit never reached the ledger (older orders, or posting
            failed after the order was saved).
          </p>
        </div>
        {debits.length === 0 ? (
          <p className="px-4 py-6 text-sm text-fg-subtle">All sales are posted. Nothing to do.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm text-fg">
              <thead className="bg-surface text-[10px] tracking-wider text-fg-subtle uppercase">
                <tr>
                  <th className="px-4 py-2.5">Order</th>
                  <th className="px-4 py-2.5">Customer</th>
                  <th className="px-4 py-2.5">Payment</th>
                  <th className="px-4 py-2.5 text-right">Amount</th>
                  <th className="px-4 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {debits.map((row) => (
                  <tr key={row.orderId} className={rowClass}>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="font-medium text-fg-strong">{row.orderNumber}</span>
                    </td>
                    <td className="px-4 py-3 text-fg-muted">{row.customerName}</td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          row.paymentStatus === 'paid'
                            ? 'rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700'
                            : 'rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-semibold text-fg-muted'
                        }
                      >
                        {row.paymentStatus}
                      </span>
                      {row.paymentMethod ? (
                        <span className="ml-1.5 text-[10px] text-fg-subtle">
                          {row.paymentMethod}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {row.currency} {money(row.amount)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <PrimaryButton
                        label="Post debit"
                        pendingLabel="Posting…"
                        pending={pending}
                        onClick={() => postDebit(row.orderId)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-xl border border-line">
        <div className="border-b border-line bg-surface-sunken/80 px-4 py-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-fg-strong">
            <ArrowDownCircle className="h-4 w-4 text-emerald-600" /> Payments missing a credit
          </h3>
          <p className="mt-0.5 text-xs text-fg-subtle">
            Receipts recorded in the customer ledger or confirmed by the gateway whose credit never
            reached the ledger.
          </p>
        </div>
        {credits.length === 0 ? (
          <p className="px-4 py-6 text-sm text-fg-subtle">
            All payments are posted. Nothing to do.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm text-fg">
              <thead className="bg-surface text-[10px] tracking-wider text-fg-subtle uppercase">
                <tr>
                  <th className="px-4 py-2.5">Source</th>
                  <th className="px-4 py-2.5">Document / Ref</th>
                  <th className="px-4 py-2.5">Customer</th>
                  <th className="px-4 py-2.5 text-right">Amount</th>
                  <th className="px-4 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {credits.map((row) => (
                  <tr key={row.key} className={rowClass}>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span
                        className={
                          row.source === 'gateway_attempt'
                            ? 'rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-300'
                            : 'rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-semibold text-fg-muted'
                        }
                      >
                        {row.source === 'gateway_attempt' ? pia(row.provider) : 'Customer'}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="font-medium text-fg-strong">{row.documentNo}</div>
                      {row.orderNumber ? (
                        <div className="text-[10px] text-fg-subtle">{row.orderNumber}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-fg-muted">{row.customerName || '—'}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {row.currency} {money(row.amount)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <PrimaryButton
                        label="Post credit"
                        pendingLabel="Posting…"
                        pending={pending}
                        onClick={() => postCredit(row.source, row.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-xl border border-line">
        <div className="border-b border-line bg-surface-sunken/80 px-4 py-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-fg-strong">
            <ToggleLeft className="h-4 w-4 text-indigo-400" /> Callback dumps without a verdict
          </h3>
          <p className="mt-0.5 text-xs text-fg-subtle">
            Provider status is the exact value from the payload. Outcome is derived from it — M-Pesa
            ResultCode 0 is successful, any other ResultCode is a failure. Classify only reads the
            stored dump; it does not retry the payment or post the ledger.
          </p>
        </div>
        {callbacks.length === 0 ? (
          <p className="px-4 py-6 text-sm text-fg-subtle">
            Every callback has a verdict. Nothing to do.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm text-fg">
              <thead className="bg-surface text-[10px] tracking-wider text-fg-subtle uppercase">
                <tr>
                  <th className="px-4 py-2.5">Received</th>
                  <th className="px-4 py-2.5">Provider</th>
                  <th className="px-4 py-2.5">Token</th>
                  <th className="px-4 py-2.5">Provider status</th>
                  <th className="px-4 py-2.5">Outcome</th>
                  <th className="px-4 py-2.5">Payload</th>
                  <th className="px-4 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {callbacks.map((row) => (
                  <tr key={row.id} className={rowClass}>
                    <td className="px-4 py-3 whitespace-nowrap text-fg-muted">
                      {new Date(row.createdAt).toLocaleString('en-GB', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-indigo-300">
                      {row.providerCode}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-fg-subtle">
                      {row.callbackToken.slice(0, 8)}…
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-fg-strong">
                      {row.processingStatus}
                    </td>
                    <td className="px-4 py-3">
                      <OutcomeBadge outcome={row.outcome} />
                    </td>
                    <td className="max-w-[260px] px-4 py-3">
                      <details className="text-fg-subtle">
                        <summary className="cursor-pointer text-[11px] text-fg-subtle hover:text-fg">
                          View payload
                        </summary>
                        <pre className="mt-1 max-h-40 overflow-auto rounded bg-surface p-2 text-[10px] text-fg-muted">
                          {JSON.stringify(row.rawBody, null, 2)}
                        </pre>
                      </details>
                      {row.processingError ? (
                        <p className="mt-1 text-[10px] text-red-600">{row.processingError}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <PrimaryButton
                        label="Classify"
                        pendingLabel="Classifying…"
                        pending={pending}
                        onClick={() => classify(row.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const className =
    outcome === 'successful'
      ? 'rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700'
      : outcome === 'failed'
        ? 'rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700'
        : outcome === 'pending'
          ? 'rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700'
          : 'rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700';
  return <span className={className}>{outcome}</span>;
}

function pia(value: string | null): string {
  if (!value) return 'Gateway';
  return value.replace('_', ' ');
}
