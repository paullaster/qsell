import { has, orElse } from '@/lib/values';
import { invoiceTitle, lineText, printableLines } from '@/lib/invoice-reference';
import type { CompanyProfile } from '@/server/ports/communications';
import { fromCents, toCents } from '../domain/receivables';
import { FinanceError } from '../errors';
import type { ReceiptService } from './receipt-service';

type Detail = NonNullable<Awaited<ReturnType<ReceiptService['detail']>>>;

/** Everything printed on a customer receipt: plain data, so the layout can change without touching the rules. */
export interface ReceiptDocument {
  company: CompanyProfile;
  number: string;
  status: 'posted' | 'reversed';
  currency: string;
  amount: string;
  /** Rate to the base currency, only for a receipt in a foreign currency. */
  rate: string | null;
  paymentDate: string;
  postingDate: string;
  customer: { name: string; number: string };
  method: string;
  reference: string | null;
  payer: string | null;
  narration: string | null;
  cheque: { number: string; bank: string; drawer: string; date: string } | null;
  applications: {
    /** "Invoice INV-0001" when one was issued, otherwise "Order ORD-1"; never the order number passed off as an invoice number. */
    title: string;
    /** The order behind an issued invoice, when there is one. */
    order: string | null;
    amount: string;
    lines: { text: string; total: string }[];
    /** Lines left out of the printout to keep it one page of reading. */
    moreLines: number;
  }[];
  unapplied: string;
  isDeposit: boolean;
  receivedBy: string | null;
  reversedOn: string | null;
}

const text = (value: string | undefined): string | null => (has(value) ? value.trim() : null);

/**
 * The printable form of a receipt. Only a receipt that has been posted (or later reversed) is a receipt:
 * a draft is not yet money received, and a cancelled one never was, so neither can be printed.
 */
export function buildReceiptDocument(detail: Detail, company: CompanyProfile): ReceiptDocument {
  const r = detail.receipt;
  if (r.status !== 'posted' && r.status !== 'reversed') {
    throw new FinanceError('NOT_ALLOWED', r.status === 'draft' ? 'A draft is not a receipt yet. Post it first, then download or print it.' : 'A cancelled draft cannot be printed.');
  }
  const cp = r.counterparty;
  const chequeNo = text(cp.chequeNo);
  // An application that was later undone no longer settles that invoice, so it is not shown.
  const live = detail.applications.filter((a) => !a.undone);
  const reversal = detail.events.find((e) => e.event === 'reversed' || e.event === 'cheque_bounced');
  return {
    company,
    number: r.number,
    status: r.status,
    currency: r.currency,
    amount: r.amount,
    rate: r.currency !== '' && Number(r.rate) !== 1 ? r.rate : null,
    paymentDate: r.paymentDate,
    postingDate: r.postingDate,
    customer: { name: detail.customer.name, number: detail.customer.number },
    method: detail.method.name,
    reference: text(r.externalReference ?? undefined),
    payer: text(r.payerName ?? undefined),
    narration: text(r.narration ?? undefined),
    cheque: chequeNo === null ? null : { number: chequeNo, bank: orElse(cp.bank, ''), drawer: orElse(cp.drawer, ''), date: orElse(cp.chequeDate, '') },
    applications: live.map((a) => {
      const ref = a.ref ?? { documentNo: a.document_no, invoiceNo: null, orderNumber: null, lines: [] };
      const { title, order } = invoiceTitle(ref);
      const { shown, more } = printableLines(ref.lines);
      return { title, order, amount: a.amount, lines: shown.map((l) => ({ text: lineText(l), total: l.total })), moreLines: more };
    }),
    unapplied: fromCents(detail.unappliedCents),
    isDeposit: r.isDeposit,
    receivedBy: has(r.postedBy) ? (detail.actors[r.postedBy] ?? null) : null,
    reversedOn: r.status === 'reversed' && reversal !== undefined ? reversal.createdAt.toISOString().slice(0, 10) : null,
  };
}

/** `Receipt PAY-0001.pdf`-style name, safe in a header and on any file system. */
export function receiptFileName(number: string): string {
  return `Receipt-${number.replace(/[^A-Za-z0-9._-]+/g, '-')}.pdf`;
}

export const applicationsTotal = (doc: ReceiptDocument): string => fromCents(doc.applications.reduce((sum, a) => sum + toCents(a.amount), 0));
