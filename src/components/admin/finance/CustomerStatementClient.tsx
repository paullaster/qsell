'use client';

import Link from 'next/link';
import { Suspense, use, useId, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { statementDocumentNumber, statementSpan } from '@/lib/customer-statement';
import {
  customerLedgerEntryDetailAction,
  customerStatementAction,
} from '@/server/domains/finance/receivables/actions';
import type { customerWalletAction } from '@/server/domains/finance/wallet-actions';
import { InvoicePdfActions } from './InvoicePdfActions';
import { ReceiptPdfActions } from './ReceiptPdfActions';
import { CustomerWalletPanel } from './CustomerWalletPanel';
import {
  Chip,
  Field,
  LoadFailed,
  Message,
  PageHeader,
  buttonClass,
  cardClass,
  fieldClass,
  money,
  primaryClass,
  type Notice,
  attempt,
} from './ui';

type View = Extract<Awaited<ReturnType<typeof customerStatementAction>>, { ok: true }>['data'];
type DetailView = Extract<
  Awaited<ReturnType<typeof customerLedgerEntryDetailAction>>,
  { ok: true }
>['data'];
type StatementLine = View['lines'][number];
type InvoiceLine = NonNullable<DetailView['invoice']>['lines'][number];
type HistoryRow = DetailView['history'][number];
interface RelatedDocument {
  documentType: string;
  documentNo: string;
  documentId: string | null;
  orderId: string | null;
}
interface RelatedPermissions {
  canReadReceipts: boolean;
  canReadOrders: boolean;
  canReadRefunds: boolean;
}
type DetailState =
  { phase: 'loading' } | { phase: 'error'; error: string } | { phase: 'ready'; data: DetailView };

const TYPE_LABEL: Record<string, string> = {
  invoice: 'Invoice',
  payment: 'Payment',
  credit_note: 'Credit note',
  refund: 'Refund',
  rebate_credit: 'Rebate credit',
  wallet_use: 'Wallet use',
};
const ENTRY_LABEL: Record<string, string> = {
  initial: 'Posted',
  application: 'Applied',
  unapplication: 'Unapplied',
  reversal: 'Reversed',
  write_off: 'Written off',
  payment_discount: 'Discount',
  rounding: 'Rounding',
  fx_gain: 'FX gain',
  fx_loss: 'FX loss',
  wallet_transfer: 'Wallet transfer',
  refund_transfer: 'Refund transfer',
};

const modalTableClass = 'hidden w-full text-left text-xs md:table';
const modalThClass = 'py-2 pr-3 font-semibold text-fg-muted';
const modalTdClass = 'py-2 pr-3 align-top';

function statementDocumentLabel(line: StatementLine): string {
  if (line.type === 'invoice') {
    const invoiceNo = statementDocumentNumber(line.type, line.documentNo, line.invoiceNo);
    return invoiceNo === '' ? 'Invoice number not recorded' : `Invoice ${invoiceNo}`;
  }
  return `${TYPE_LABEL[line.type] ?? line.type} ${line.documentNo}`;
}

function taxInvoiceLabel(invoiceNo: string | null): string {
  return invoiceNo === null || invoiceNo === ''
    ? 'Tax invoice number not recorded'
    : `Tax invoice ${invoiceNo}`;
}

function quantityText(line: InvoiceLine): string {
  return line.unit !== null && line.unit !== '' ? `${line.quantity} ${line.unit}` : line.quantity;
}

function discountText(line: InvoiceLine): { amount: string; label: string } | null {
  if (line.savedAmount === null || line.savedAmount === undefined || Number(line.savedAmount) === 0)
    return null;
  return {
    amount: line.savedAmount,
    label:
      line.discountLabel?.trim() === '' ||
      line.discountLabel === null ||
      line.discountLabel === undefined
        ? 'Discount'
        : line.discountLabel,
  };
}

function historyWhat(h: HistoryRow, documentType: string): string {
  const label = ENTRY_LABEL[h.entryType] ?? h.entryType;
  if (h.relatedDocumentNo === null || h.relatedDocumentNo === '') return label;
  const related = `${TYPE_LABEL[h.relatedDocumentType ?? ''] ?? 'Document'} ${h.relatedDocumentNo}`;
  if (h.entryType === 'application')
    return documentType === 'invoice' ? `Applied from ${related}` : `Applied to ${related}`;
  if (h.entryType === 'unapplication') return `Unapplied from ${related}`;
  return `${label} · ${related}`;
}

function historyWhy(h: HistoryRow): string {
  const parts: string[] = [];
  const reason = [h.reasonText, h.reasonCode]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(' · ');
  if (reason !== '') parts.push(reason);
  if (h.createdBy !== null && h.createdBy.trim() !== '') parts.push(`Recorded by ${h.createdBy}`);
  return parts.length === 0 ? '—' : parts.join(' · ');
}

function relatedDocumentHref(doc: RelatedDocument, permissions: RelatedPermissions): string | null {
  if (
    doc.documentType === 'payment' &&
    permissions.canReadReceipts &&
    doc.documentId !== null &&
    doc.documentId !== ''
  )
    return `/admin/finance/receipts/${encodeURIComponent(doc.documentId)}`;
  if (
    doc.documentType === 'refund' &&
    permissions.canReadRefunds &&
    doc.documentId !== null &&
    doc.documentId !== ''
  )
    return `/admin/finance/refunds/${encodeURIComponent(doc.documentId)}`;
  if (permissions.canReadOrders && doc.orderId !== null && doc.orderId !== '')
    return `/admin/orders?order=${encodeURIComponent(doc.orderId)}`;
  return null;
}

function relatedDocumentLabel(doc: Pick<RelatedDocument, 'documentType' | 'documentNo'>): string {
  return `${TYPE_LABEL[doc.documentType] ?? doc.documentType} ${doc.documentNo}`;
}

interface Props {
  statementPromise: ReturnType<typeof customerStatementAction>;
  walletPromise: ReturnType<typeof customerWalletAction>;
  canReceivePromise: Promise<boolean>;
  canReadReceiptsPromise: Promise<boolean>;
  canReadOrdersPromise: Promise<boolean>;
  canReadRefundsPromise: Promise<boolean>;
}

const shown = (value: string | null | undefined): string =>
  value === null || value === undefined || value.trim() === '' ? '—' : value;

const amountOrDash = (value: string): string => (Number(value) === 0 ? '—' : money(value));
const balanceMoney = (value: string): string =>
  value.startsWith('-') ? `(${money(value.slice(1))})` : money(value);

export function CustomerStatementClient({
  statementPromise,
  walletPromise,
  canReceivePromise,
  canReadReceiptsPromise,
  canReadOrdersPromise,
  canReadRefundsPromise,
}: Props) {
  const statement = use(statementPromise);
  const canReceive = use(canReceivePromise);
  const canReadReceipts = use(canReadReceiptsPromise);
  const canReadOrders = use(canReadOrdersPromise);
  const canReadRefunds = use(canReadRefundsPromise);
  if (!statement.ok) return <LoadFailed error={statement.error} />;
  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title={statement.data.customer.name}
        intro={
          <span className="flex flex-wrap items-center gap-2">
            Customer {statement.data.customer.number} ·{' '}
            <Chip tone={statement.data.customer.accountType === 'credit' ? 'sky' : 'gray'}>
              {statement.data.customer.accountType === 'credit'
                ? 'Credit account'
                : 'Cash customer'}
            </Chip>
            {statement.data.customer.blocked !== 'none' ? (
              <Chip tone="red">Blocked: {statement.data.customer.blocked}</Chip>
            ) : null}
          </span>
        }
        actions={
          canReceive ? (
            <Link
              className={primaryClass}
              href={`/admin/finance/receipts/new?customer=${encodeURIComponent(statement.data.customer.number)}`}
            >
              Record a receipt
            </Link>
          ) : null
        }
      />
      <CustomerStatementPanel
        initial={statement.data}
        canReadReceipts={canReadReceipts}
        canReadOrders={canReadOrders}
        canReadRefunds={canReadRefunds}
        walletPromise={walletPromise}
      />
    </div>
  );
}

function WalletSection({
  customerId,
  walletPromise,
}: {
  customerId: string;
  walletPromise: ReturnType<typeof customerWalletAction>;
}) {
  const wallet = use(walletPromise);
  return wallet.ok ? <CustomerWalletPanel customerId={customerId} view={wallet.data} /> : null;
}

export function CustomerStatementPanel({
  initial,
  canReadReceipts,
  canReadOrders,
  canReadRefunds,
  walletPromise,
}: {
  initial: View;
  canReadReceipts: boolean;
  canReadOrders: boolean;
  canReadRefunds: boolean;
  walletPromise: ReturnType<typeof customerWalletAction> | null;
}) {
  const uid = useId();
  const [ranged, setRanged] = useState<{ data: View; from: string; to: string } | null>(null);
  const [moreLines, setMoreLines] = useState<StatementLine[]>([]);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [range, setRange] = useState(() => statementSpan(initial.lines, { from: '', to: '' }));
  const [busy, setBusy] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [selected, setSelected] = useState<{ id: string; label: string } | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const detailRequest = useRef(0);

  const view = ranged?.data ?? initial;
  const lines = [...view.lines, ...moreLines];
  const c = view.customer;

  const refresh = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await attempt(
      customerStatementAction(
        view.customer.id,
        range.from === '' ? undefined : range.from,
        range.to === '' ? undefined : range.to,
      ),
    );
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice(null);
    setRanged({ data: res.data, from: range.from, to: range.to });
    setRange(statementSpan(res.data.lines, { from: range.from, to: range.to }));
    setMoreLines([]);
    setCursor(res.data.nextCursor);
  };

  const more = async () => {
    if (cursor === null || moreBusy) return;
    setMoreBusy(true);
    const from = ranged?.from === '' || ranged?.from === undefined ? undefined : ranged.from;
    const to = ranged?.to === '' || ranged?.to === undefined ? undefined : ranged.to;
    const res = await attempt(customerStatementAction(view.customer.id, from, to, cursor));
    setMoreBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice(null);
    const nextLines = [...moreLines, ...res.data.lines];
    setMoreLines(nextLines);
    setRange(
      statementSpan(
        [...view.lines, ...nextLines],
        ranged === null ? { from: '', to: '' } : { from: ranged.from, to: ranged.to },
      ),
    );
    setCursor(res.data.nextCursor);
  };

  const openDetail = async (line: StatementLine) => {
    const request = detailRequest.current + 1;
    detailRequest.current = request;
    setSelected({ id: line.id, label: statementDocumentLabel(line) });
    setDetail({ phase: 'loading' });
    const res = await attempt(customerLedgerEntryDetailAction(line.id));
    if (request !== detailRequest.current) return;
    setDetail(res.ok ? { phase: 'ready', data: res.data } : { phase: 'error', error: res.error });
  };

  const closeDetail = () => {
    detailRequest.current += 1;
    setSelected(null);
    setDetail(null);
  };

  return (
    <div className="space-y-5">
      <Message notice={notice} />
      <section
        aria-label="Customer statement balances"
        className="grid grid-cols-2 gap-3 md:grid-cols-4"
      >
        <Balance title="Opening balance" value={balanceMoney(view.openingBalance)} />
        <Balance title="Debits this period" value={money(view.totalDebit)} />
        <Balance title="Credits this period" value={money(view.totalCredit)} />
        <Balance title="Closing balance" value={balanceMoney(view.closingBalance)} />
      </section>
      <section aria-label="Position" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className={cardClass}>
          <p className="text-xs text-fg-muted">
            {view.creditLimitDisplay === 'static' ? 'Set credit limit' : 'Credit limit'}
          </p>
          <p className="text-lg font-bold text-fg-strong tabular-nums">
            {c.accountType === 'credit' ? money(c.creditLimit) : '—'}
          </p>
        </div>
        {view.creditLimitDisplay === 'running' ? (
          <div className={cardClass}>
            <p className="text-xs text-fg-muted">Available credit</p>
            <p className="text-lg font-bold text-fg-strong tabular-nums">
              {money(view.availableCredit)}
            </p>
          </div>
        ) : null}
      </section>

      {walletPromise === null ? null : (
        <Suspense
          fallback={
            <p className="text-xs text-fg-muted" role="status">
              Loading the wallet…
            </p>
          }
        >
          <WalletSection customerId={c.id} walletPromise={walletPromise} />
        </Suspense>
      )}

      <section aria-labelledby={`${uid}-age`} className="space-y-2">
        <h3 id={`${uid}-age`} className="text-sm font-bold text-fg-strong">
          By age
        </h3>
        <ul className="grid grid-cols-2 gap-2 md:grid-cols-5">
          {view.ageing.map((b) => (
            <li key={b.label} className="rounded-xl border border-line bg-surface-raised p-3">
              <p className="text-xs text-fg-muted">{b.label}</p>
              <p className="text-sm font-bold text-fg-strong tabular-nums">{money(b.amount)}</p>
              <p className="text-[11px] text-fg-muted">
                {b.count} {b.count === 1 ? 'invoice' : 'invoices'}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <form
        onSubmit={refresh}
        className={`${cardClass} grid grid-cols-1 gap-3 sm:grid-cols-4`}
        aria-label="Date range"
      >
        <Field id={`${uid}-from`} label="From">
          <input
            id={`${uid}-from`}
            type="date"
            value={range.from}
            onChange={(e) => setRange({ ...range, from: e.target.value })}
            className={fieldClass}
          />
        </Field>
        <Field id={`${uid}-to`} label="To">
          <input
            id={`${uid}-to`}
            type="date"
            value={range.to}
            onChange={(e) => setRange({ ...range, to: e.target.value })}
            className={fieldClass}
          />
        </Field>
        <div className="flex items-end">
          <button type="submit" className={buttonClass} disabled={busy}>
            {busy ? 'Showing…' : 'Show'}
          </button>
        </div>
      </form>

      <section aria-labelledby={`${uid}-statement`} className="space-y-3">
        <h3 id={`${uid}-statement`} className="text-sm font-bold text-fg-strong">
          Customer statement
        </h3>
        {lines.length === 0 ? (
          <p className="text-sm text-fg-muted">No entries in this range.</p>
        ) : (
          <>
            <ul className="space-y-2 md:hidden" aria-label="Customer statement">
              {lines.map((l) => (
                <li key={l.id} className={`${cardClass} space-y-2`}>
                  <div>
                    <p className="text-xs text-fg-muted">{shown(l.date)}</p>
                    <p className="font-semibold text-fg-strong">{statementDocumentLabel(l)}</p>
                  </div>
                  <p className="text-sm text-fg">{shown(l.description)}</p>
                  <dl className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <dt className="text-fg-muted">Debit</dt>
                      <dd className="font-semibold text-fg-strong tabular-nums">
                        <StatementAmount
                          line={l}
                          kind="debit"
                          value={l.debit}
                          onOpen={openDetail}
                        />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-fg-muted">Credit</dt>
                      <dd className="font-semibold text-fg-strong tabular-nums">
                        <StatementAmount
                          line={l}
                          kind="credit"
                          value={l.credit}
                          onOpen={openDetail}
                        />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-fg-muted">Balance</dt>
                      <dd className="font-semibold text-fg-strong tabular-nums">
                        {balanceMoney(l.balance)}
                      </dd>
                    </div>
                  </dl>
                  {l.type === 'payment' && l.documentId !== null && l.documentId !== '' ? (
                    <div className="flex flex-wrap gap-2">
                      <Link
                        className="text-xs font-semibold text-indigo-600 hover:underline"
                        href={`/admin/finance/receipts/${l.documentId}`}
                      >
                        Open receipt
                      </Link>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            <div
              className={`${cardClass} flex flex-wrap items-center justify-between gap-2 md:hidden`}
            >
              <span className="text-sm font-bold text-fg-strong">Total balance</span>
              <span className="inline-block border-b-4 border-double border-current pb-0.5 text-sm font-bold text-fg-strong tabular-nums">
                {balanceMoney(view.closingBalance)}
              </span>
            </div>
            <table className="hidden w-full text-left text-xs md:table">
              <caption className="sr-only">Customer statement, oldest first</caption>
              <thead className="text-fg-muted">
                <tr>
                  <th scope="col" className="py-2 pr-3">
                    Date
                  </th>
                  <th scope="col" className="pr-3">
                    Document
                  </th>
                  <th scope="col" className="hidden pr-3 lg:table-cell">
                    Description
                  </th>
                  <th scope="col" className="hidden pr-3 lg:table-cell">
                    Due
                  </th>
                  <th scope="col" className="pr-3 text-right">
                    Debit
                  </th>
                  <th scope="col" className="pr-3 text-right">
                    Credit
                  </th>
                  <th scope="col" className="pr-3 text-right">
                    Balance
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className="border-t border-line align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">{shown(l.date)}</td>
                    <td className="pr-3 whitespace-nowrap">
                      {l.type === 'payment' && l.documentId !== null && l.documentId !== '' ? (
                        <Link
                          className="font-semibold text-indigo-600 hover:underline"
                          href={`/admin/finance/receipts/${l.documentId}`}
                        >
                          {statementDocumentLabel(l)}
                        </Link>
                      ) : (
                        <span className="font-semibold">{statementDocumentLabel(l)}</span>
                      )}
                    </td>
                    <td className="hidden pr-3 lg:table-cell">{shown(l.description)}</td>
                    <td className="hidden pr-3 whitespace-nowrap lg:table-cell">
                      {shown(l.dueDate)}
                    </td>
                    <td className="pr-3 text-right tabular-nums">
                      <StatementAmount line={l} kind="debit" value={l.debit} onOpen={openDetail} />
                    </td>
                    <td className="pr-3 text-right tabular-nums">
                      <StatementAmount
                        line={l}
                        kind="credit"
                        value={l.credit}
                        onOpen={openDetail}
                      />
                    </td>
                    <td className="pr-3 text-right font-semibold tabular-nums">
                      {balanceMoney(l.balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line text-fg-strong">
                  <td className="py-2 pr-3" />
                  <td className="py-2 pr-3 font-bold">Total balance</td>
                  <td className="hidden pr-3 lg:table-cell" />
                  <td className="hidden pr-3 lg:table-cell" />
                  <td className="pr-3" />
                  <td className="pr-3" />
                  <td className="pr-3 text-right font-bold tabular-nums">
                    <span className="inline-block border-b-4 border-double border-current pb-0.5">
                      {balanceMoney(view.closingBalance)}
                    </span>
                  </td>
                </tr>
              </tfoot>
            </table>
            {cursor === null ? null : (
              <div className="flex justify-center">
                <button
                  type="button"
                  className={buttonClass}
                  disabled={moreBusy}
                  onClick={() => void more()}
                >
                  {moreBusy ? 'Loading more…' : 'Show more transactions'}
                </button>
              </div>
            )}
          </>
        )}
      </section>
      <p className="text-[11px] text-fg-muted">
        Invoices are debits; payments, credit notes and refunds are credits. The balance runs from
        the opening balance shown above.
      </p>

      {selected === null ? null : (
        <Modal title={`Transaction detail: ${selected.label}`} onClose={closeDetail} wide>
          {detail === null || detail.phase === 'loading' ? (
            <p role="status" className="text-sm text-fg-muted">
              Loading the transaction…
            </p>
          ) : null}
          {detail?.phase === 'error' ? <LoadFailed error={detail.error} /> : null}
          {detail?.phase === 'ready' ? (
            <TransactionDetail
              view={detail.data}
              canReadReceipts={canReadReceipts}
              canReadOrders={canReadOrders}
              canReadRefunds={canReadRefunds}
            />
          ) : null}
        </Modal>
      )}
    </div>
  );
}

function Balance({ title, value }: { title: string; value: string }) {
  return (
    <div className={cardClass}>
      <p className="text-xs text-fg-muted">{title}</p>
      <p className="text-lg font-bold text-fg-strong tabular-nums">{value}</p>
    </div>
  );
}

function StatementAmount({
  line,
  kind,
  value,
  onOpen,
}: {
  line: StatementLine;
  kind: 'debit' | 'credit';
  value: string;
  onOpen: (line: StatementLine) => Promise<void>;
}) {
  if (Number(value) === 0) return <>{amountOrDash(value)}</>;
  return (
    <button
      type="button"
      className="cursor-pointer font-semibold text-blue-600 hover:text-blue-800 hover:underline hover:underline-offset-2 focus-visible:underline focus-visible:underline-offset-2"
      onClick={() => void onOpen(line)}
      aria-label={`View details for ${statementDocumentLabel(line)} ${kind}`}
    >
      {amountOrDash(value)}
    </button>
  );
}

function TransactionDetail({
  view,
  canReadReceipts,
  canReadOrders,
  canReadRefunds,
}: {
  view: DetailView;
  canReadReceipts: boolean;
  canReadOrders: boolean;
  canReadRefunds: boolean;
}) {
  const e = view.entry;
  const permissions = { canReadReceipts, canReadOrders, canReadRefunds };
  const receiptId = e.type === 'payment' ? e.documentId : null;
  const orderId =
    e.orderId !== null && e.orderId !== '' ? e.orderId : (view.invoice?.orderId ?? null);
  const canShowReceipt = canReadReceipts && receiptId !== null && receiptId !== '';
  const invoiceNo = view.invoice?.invoiceNo ?? null;
  const taxInvoiceHref =
    canReadOrders && orderId !== null && orderId !== '' && invoiceNo !== null && invoiceNo !== ''
      ? `/api/admin/finance/invoices/${encodeURIComponent(orderId)}/pdf`
      : null;
  const canShowInvoice = taxInvoiceHref !== null;
  const invoiceNumber = invoiceNo ?? 'this invoice';
  const currentDocument: RelatedDocument = {
    documentType: e.type,
    documentNo: e.documentNo,
    documentId: e.documentId,
    orderId: e.orderId,
  };
  const currentDocumentHref =
    e.type === 'invoice' ? null : relatedDocumentHref(currentDocument, permissions);
  const documentLabel =
    e.type === 'invoice' ? taxInvoiceLabel(invoiceNo) : relatedDocumentLabel(currentDocument);
  const title =
    view.invoice === null
      ? null
      : [
          taxInvoiceLabel(invoiceNo),
          view.invoice.orderNumber === null || view.invoice.orderNumber === ''
            ? null
            : `Source sales order ${view.invoice.orderNumber}`,
        ]
          .filter((part): part is string => part !== null)
          .join(' · ');
  const appliedTitle =
    e.type === 'invoice'
      ? 'Payments and credits applied to this invoice'
      : 'Applied to invoices and other documents';
  return (
    <div className="space-y-5">
      {canShowReceipt || canShowInvoice ? (
        <section aria-label="Document actions" className="flex flex-wrap gap-2">
          {canShowReceipt ? (
            <ReceiptPdfActions receiptId={receiptId} status="posted" number={e.documentNo} />
          ) : null}
          {canShowInvoice ? (
            <InvoicePdfActions orderId={orderId ?? ''} number={invoiceNumber} />
          ) : null}
        </section>
      ) : null}
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Detail label="Document" value={documentLabel} />
        <Detail label="Date" value={shown(e.date)} />
        <Detail label="Document amount" value={money(e.amount)} />
        <Detail label="Still open" value={money(e.remaining)} />
        <Detail label="Due" value={shown(e.dueDate)} />
        <Detail label="Currency" value={shown(e.currency)} />
        <Detail label="Description" value={shown(e.description)} />
      </dl>

      <section aria-label="Related documents" className="space-y-2">
        <h3 className="text-sm font-bold text-fg-strong">Related documents</h3>
        {view.invoice === null && currentDocumentHref === null ? (
          <p className="text-sm text-fg-muted">No related documents are available.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {view.invoice === null ? null : (
              <>
                <li>
                  <span className="font-semibold">Tax invoice:</span>{' '}
                  {invoiceNo === null || invoiceNo === '' ? 'number not recorded' : invoiceNo}
                </li>
                {taxInvoiceHref === null ? null : (
                  <li>
                    <a
                      className="font-semibold text-indigo-600 hover:underline"
                      href={taxInvoiceHref}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open tax invoice PDF
                    </a>
                  </li>
                )}
                {canReadOrders && orderId !== null && orderId !== '' ? (
                  <li>
                    <Link
                      className="font-semibold text-indigo-600 hover:underline"
                      href={`/admin/orders?order=${encodeURIComponent(orderId)}`}
                    >
                      Open source sales order
                      {view.invoice.orderNumber === null || view.invoice.orderNumber === ''
                        ? ''
                        : ` ${view.invoice.orderNumber}`}
                    </Link>
                  </li>
                ) : null}
              </>
            )}
            {currentDocumentHref === null ? null : (
              <li>
                <Link
                  className="font-semibold text-indigo-600 hover:underline"
                  href={currentDocumentHref}
                >
                  Open {relatedDocumentLabel(currentDocument)}
                </Link>
              </li>
            )}
          </ul>
        )}
      </section>

      {view.invoice === null ? null : (
        <section aria-label="Items sold" className="space-y-2">
          <div>
            <h3 className="text-sm font-bold text-fg-strong">Items sold</h3>
            <p className="text-xs text-fg-muted">{title}</p>
          </div>
          {view.invoice.lines.length === 0 ? (
            <p className="text-sm text-fg-muted">No line items were recorded for this sale.</p>
          ) : (
            <>
              <ul className="space-y-2 md:hidden" aria-label="Items sold">
                {view.invoice.lines.map((l) => {
                  const discount = discountText(l);
                  return (
                    <li key={l.id} className={`${cardClass} space-y-2`}>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold text-fg-strong">{l.name}</p>
                          {l.sku.trim() === '' ? null : (
                            <p className="text-xs text-fg-muted">{l.sku}</p>
                          )}
                        </div>
                        {l.gift ? <Chip tone="sky">Free gift</Chip> : null}
                      </div>
                      <dl className="grid grid-cols-2 gap-2 text-xs">
                        <MobileField label="Qty">{quantityText(l)}</MobileField>
                        <MobileField label="Unit price">{money(l.unitPrice)}</MobileField>
                        <MobileField label="Discount">
                          {discount === null ? (
                            '—'
                          ) : (
                            <span className="text-emerald-700">
                              {money(discount.amount)} saved
                              <span className="block font-normal text-fg-muted">
                                {discount.label}
                              </span>
                            </span>
                          )}
                        </MobileField>
                        <MobileField label="Line total">{money(l.total)}</MobileField>
                      </dl>
                    </li>
                  );
                })}
              </ul>
              <table className={modalTableClass}>
                <caption className="sr-only">Items sold on {title ?? documentLabel}</caption>
                <thead className="text-fg-muted">
                  <tr>
                    <th scope="col" className={modalThClass}>
                      Item
                    </th>
                    <th scope="col" className={modalThClass}>
                      Qty
                    </th>
                    <th scope="col" className={`${modalThClass} text-right`}>
                      Unit price
                    </th>
                    <th scope="col" className={`${modalThClass} text-right`}>
                      Discount
                    </th>
                    <th scope="col" className="py-2 text-right font-semibold text-fg-muted">
                      Line total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {view.invoice.lines.map((l) => {
                    const discount = discountText(l);
                    return (
                      <tr key={l.id} className="border-t border-line">
                        <td className={`${modalTdClass} font-semibold text-fg-strong`}>
                          <div>{l.name}</div>
                          {l.sku.trim() === '' ? null : (
                            <div className="text-xs font-normal text-fg-muted">{l.sku}</div>
                          )}
                          {l.gift ? (
                            <div className="mt-1">
                              <Chip tone="sky">Free gift</Chip>
                            </div>
                          ) : null}
                        </td>
                        <td className={`${modalTdClass} whitespace-nowrap`}>{quantityText(l)}</td>
                        <td className={`${modalTdClass} text-right tabular-nums`}>
                          {money(l.unitPrice)}
                        </td>
                        <td className={`${modalTdClass} text-right`}>
                          {discount === null ? (
                            <span className="text-fg-muted">—</span>
                          ) : (
                            <>
                              <div className="font-semibold text-emerald-700">
                                {money(discount.amount)} saved
                              </div>
                              <div className="text-xs text-fg-muted">{discount.label}</div>
                            </>
                          )}
                        </td>
                        <td className="py-2 text-right font-semibold tabular-nums">
                          {money(l.total)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}

      <section aria-label={appliedTitle} className="space-y-2">
        <h3 className="text-sm font-bold text-fg-strong">{appliedTitle}</h3>
        {view.applied.length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing has been applied to this document.</p>
        ) : (
          <>
            <ul className="space-y-2 md:hidden" aria-label={appliedTitle}>
              {view.applied.map((a) => (
                <li key={a.id} className={`${cardClass} space-y-2`}>
                  <div>
                    <DocumentNumberLink
                      doc={a}
                      permissions={permissions}
                      className="font-semibold text-fg-strong"
                    />
                    <p className="text-xs text-fg-muted">
                      {TYPE_LABEL[a.documentType] ?? a.documentType}
                    </p>
                  </div>
                  <dl className="grid grid-cols-2 gap-2 text-xs">
                    <MobileField label="Amount applied">{money(a.appliedAmount)}</MobileField>
                    <MobileField label="Document amount">{money(a.documentAmount)}</MobileField>
                    <MobileField label="Still open">{money(a.stillOpen)}</MobileField>
                  </dl>
                </li>
              ))}
            </ul>
            <table className={modalTableClass}>
              <caption className="sr-only">{appliedTitle}</caption>
              <thead className="text-fg-muted">
                <tr>
                  <th scope="col" className={modalThClass}>
                    Document
                  </th>
                  <th scope="col" className={modalThClass}>
                    Type
                  </th>
                  <th scope="col" className={`${modalThClass} text-right`}>
                    Amount applied
                  </th>
                  <th scope="col" className={`${modalThClass} text-right`}>
                    Document amount
                  </th>
                  <th scope="col" className="py-2 text-right font-semibold text-fg-muted">
                    Still open
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.applied.map((a) => (
                  <tr key={a.id} className="border-t border-line">
                    <td className={`${modalTdClass} font-semibold`}>
                      <DocumentNumberLink
                        doc={a}
                        permissions={permissions}
                        className="font-semibold"
                      />
                    </td>
                    <td className={modalTdClass}>{TYPE_LABEL[a.documentType] ?? a.documentType}</td>
                    <td className={`${modalTdClass} text-right font-semibold tabular-nums`}>
                      {money(a.appliedAmount)}
                    </td>
                    <td className={`${modalTdClass} text-right tabular-nums`}>
                      {money(a.documentAmount)}
                    </td>
                    <td className="py-2 text-right tabular-nums">{money(a.stillOpen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section aria-label="History" className="space-y-2">
        <h3 className="text-sm font-bold text-fg-strong">History</h3>
        {view.history.length === 0 ? (
          <p className="text-sm text-fg-muted">No history entries.</p>
        ) : (
          <>
            <ul className="space-y-2 md:hidden" aria-label="History">
              {view.history.map((h) => (
                <li key={h.id} className={`${cardClass} space-y-2`}>
                  <div>
                    <p className="font-semibold text-fg-strong">{historyWhat(h, e.type)}</p>
                    <p className="text-xs text-fg-muted">{shown(h.postingDate)}</p>
                  </div>
                  <dl className="grid grid-cols-2 gap-2 text-xs">
                    <MobileField label="Amount">{money(h.amount)}</MobileField>
                    <MobileField label="Why / by whom">{historyWhy(h)}</MobileField>
                  </dl>
                </li>
              ))}
            </ul>
            <table className={modalTableClass}>
              <caption className="sr-only">
                History of {TYPE_LABEL[e.type] ?? e.type} {e.documentNo}
              </caption>
              <thead className="text-fg-muted">
                <tr>
                  <th scope="col" className={modalThClass}>
                    When
                  </th>
                  <th scope="col" className={modalThClass}>
                    What happened
                  </th>
                  <th scope="col" className={`${modalThClass} text-right`}>
                    Amount
                  </th>
                  <th scope="col" className={modalThClass}>
                    Why / by whom
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.history.map((h) => (
                  <tr key={h.id} className="border-t border-line">
                    <td className={`${modalTdClass} whitespace-nowrap`}>{shown(h.postingDate)}</td>
                    <td className={`${modalTdClass} font-semibold`}>{historyWhat(h, e.type)}</td>
                    <td className={`${modalTdClass} text-right tabular-nums`}>{money(h.amount)}</td>
                    <td className={`${modalTdClass} text-fg-muted`}>{historyWhy(h)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="mt-0.5 text-fg-strong">{value}</dd>
    </div>
  );
}

function MobileField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="mt-0.5 font-semibold text-fg-strong">{children}</dd>
    </div>
  );
}

function DocumentNumberLink({
  doc,
  permissions,
  className,
}: {
  doc: RelatedDocument;
  permissions: RelatedPermissions;
  className: string;
}) {
  const href = relatedDocumentHref(doc, permissions);
  if (href === null) return <span className={className}>{doc.documentNo}</span>;
  return (
    <Link
      className={`${className} text-indigo-600 hover:underline`}
      href={href}
      aria-label={`Open related document ${doc.documentNo}`}
    >
      {doc.documentNo}
    </Link>
  );
}
