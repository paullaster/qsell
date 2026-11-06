import { has, orElse } from '@/lib/values';
import { printableLines } from '@/lib/invoice-reference';
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
  /**
   * What the money paid for, line by line. A receipt names no invoice or order number: it shows the items, the quantity, the price
   * and the amount, so the customer sees what they paid for and the books keep the references.
   */
  items: ReceiptItem[];
  /** Items left out of the printout to keep it readable; the total still counts them. */
  moreItems: number;
  /** The value of all the items listed, before looking at how much of it this receipt paid. */
  itemsTotal: string;
  /** What this receipt applied to those items. */
  applied: string;
  unapplied: string;
  isDeposit: boolean;
  receivedBy: string | null;
  reversedOn: string | null;
}

export interface ReceiptItem {
  description: string;
  /** "35 PCS", or empty for a line that has no quantity (a payment on a sale whose lines are not known). */
  quantity: string;
  unitPrice: string | null;
  amount: string;
}

/** Items printed on one receipt before the rest are summarised. */
const MAX_ITEMS = 200;

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
    ...itemsOf(live),
    unapplied: fromCents(detail.unappliedCents),
    isDeposit: r.isDeposit,
    receivedBy: has(r.postedBy) ? (detail.actors[r.postedBy] ?? null) : null,
    reversedOn: r.status === 'reversed' && reversal !== undefined ? reversal.createdAt.toISOString().slice(0, 10) : null,
  };
}

type Live = Detail['applications'][number];

/** The items behind every live application, in order, with no invoice or order number anywhere. */
function itemsOf(live: Live[]): Pick<ReceiptDocument, 'items' | 'moreItems' | 'itemsTotal' | 'applied'> {
  const items: ReceiptItem[] = [];
  let more = 0;
  let totalCents = 0;
  let appliedCents = 0;
  for (const a of live) {
    appliedCents += toCents(a.amount);
    const lines = a.ref?.lines ?? [];
    if (lines.length === 0) {
      // The sale's lines are not known: say what was paid, not which document it was.
      items.push({ description: 'Goods and services sold', quantity: '', unitPrice: null, amount: a.amount });
      totalCents += toCents(a.amount);
      continue;
    }
    const { shown, more: left } = printableLines(lines, MAX_ITEMS);
    more += left;
    for (const l of lines) totalCents += toCents(l.total);
    for (const l of shown) {
      items.push({
        description: `${l.name}${l.gift ? ' (free gift)' : ''}`,
        quantity: has(l.unit ?? undefined) ? `${trimQuantity(l.quantity)} ${l.unit ?? ''}` : trimQuantity(l.quantity),
        unitPrice: l.unitPrice,
        amount: l.total,
      });
    }
  }
  return { items, moreItems: more, itemsTotal: fromCents(totalCents), applied: fromCents(appliedCents) };
}

/** "35.0000" prints as "35"; "2.5000" as "2.5". */
export function trimQuantity(quantity: string): string {
  const n = Number(quantity);
  return Number.isFinite(n) ? String(Number(n.toFixed(4))) : quantity;
}

/** `Receipt PAY-0001.pdf`-style name, safe in a header and on any file system. */
export function receiptFileName(number: string): string {
  return `Receipt-${number.replace(/[^A-Za-z0-9._-]+/g, '-')}.pdf`;
}
