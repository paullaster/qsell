/**
 * What a quote can become, in the words of the person at the counter. The four choices, what each one will do (worked out from the company's
 * own settings for that kind of document), and, for one that cannot be chosen, the reason in plain words. Pure: the facts come in, the
 * choices go out; the server gathers the facts and decides again when the conversion is made.
 */

export const QUOTE_TARGETS = ['sales_order', 'sales_invoice', 'credit_sale', 'cash_sale'] as const;
export type QuoteTarget = (typeof QUOTE_TARGETS)[number];
export const isQuoteTarget = (value: unknown): value is QuoteTarget => typeof value === 'string' && (QUOTE_TARGETS as readonly string[]).includes(value);

export interface TargetWords {
  label: string;
  /** What it is for, in one line. */
  forWhen: string;
  /** The button that confirms it. */
  action: string;
  /** What the new document is called, for "Invoice INV-1 was created". */
  made: string;
}

export const TARGET_WORDS: Record<QuoteTarget, TargetWords> = {
  sales_order: { label: 'Sales order', forWhen: 'The customer has agreed. You will prepare and deliver the goods, and bill later.', action: 'Create the sales order', made: 'Sales order' },
  sales_invoice: { label: 'Sales invoice', forWhen: 'Bill the customer now, with the tax invoice, and deliver afterwards.', action: 'Issue the sales invoice', made: 'Sales invoice' },
  credit_sale: { label: 'Credit sale', forWhen: 'Sell on the customer’s account: they pay later, within their credit terms.', action: 'Sell on credit', made: 'Credit sale' },
  cash_sale: { label: 'Cash sale', forWhen: 'The customer pays now, at the counter. They leave with the goods and a receipt.', action: 'Take payment and finish', made: 'Cash sale' },
};

/** The permission each target needs, besides the right to approve quotes. */
export const TARGET_PERMISSION: Record<QuoteTarget, string> = {
  sales_order: 'orders:create',
  sales_invoice: 'sales_invoices:create',
  credit_sale: 'credit_sales:create',
  cash_sale: 'cash_sales:create',
};

/** What the company's settings for one kind of document say, as far as a conversion needs them. */
export interface KindSettings {
  stockRelease: 'on_issue' | 'on_payment' | 'on_delivery';
  approval: 'workflow' | 'never';
  invoice: 'with_document' | 'later';
  creditCheck: 'off' | 'limit' | 'limit_and_overdue';
  overLimit: 'refuse' | 'hold';
  creditDays: 'customer' | 'fixed' | 'on_issue';
  fixedDays: number;
}

export interface CustomerFacts {
  name: string;
  hasCreditAccount: boolean;
  blocked: boolean;
  creditLimit: number;
  /** What is left of the limit, as the company shows it (null: not shown). */
  available: number | null;
  termDays: number;
  overdue: boolean;
}

export interface ConversionFacts {
  quoteNumber: string;
  status: string;
  expired: boolean;
  /** Where it already went, when it has: the document and its number. */
  convertedTo: { label: string; number: string } | null;
  addressComplete: boolean;
  total: number;
  currency: string;
  deliveryFee: number;
  customer: CustomerFacts | null;
  /** The settings of each kind of document. */
  settings: Record<QuoteTarget, KindSettings>;
  /** The permissions the person holds. */
  can: Record<QuoteTarget, boolean>;
  canApprove: boolean;
  /** Whether the person has a till shift open (a cash sale is taken in it). */
  shiftOpen: boolean;
}

export interface ConversionChoice {
  target: QuoteTarget;
  label: string;
  forWhen: string;
  action: string;
  /** Can it be chosen now? */
  available: boolean;
  /** Why not, in words, when it cannot. */
  reason: string | null;
  /** What will happen if it is chosen: short, plain sentences. */
  effects: string[];
  /** What to look at before choosing: a limit that will hold it for approval, an overdue invoice. */
  cautions: string[];
}

const money = (currency: string, value: number): string => `${currency} ${value.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const stockWords = (s: KindSettings): string => {
  if (s.stockRelease === 'on_issue') return 'The stock leaves as soon as it is issued.';
  if (s.stockRelease === 'on_payment') return 'The stock is set aside for the customer and leaves when they have paid.';
  return 'The stock is set aside for the customer and leaves when the goods are handed over.';
};

const dueWords = (s: KindSettings, termDays: number): string => {
  if (s.creditDays === 'on_issue') return 'Due on issue.';
  if (s.creditDays === 'fixed') return `Due in ${String(s.fixedDays)} days.`;
  return `Due in ${String(termDays)} days, as on their account.`;
};

const approvalWords = (s: KindSettings): string | null => (s.approval === 'workflow' ? 'It waits for approval only if one of the company’s approval rules applies to it.' : null);

/** Why a quote cannot become anything yet, or null when it can. These hold for all four choices. */
export function quoteBlock(f: ConversionFacts): string | null {
  if (f.convertedTo !== null) return `This quote already became ${f.convertedTo.label.toLowerCase()} ${f.convertedTo.number}.`;
  if (f.status === 'cancelled') return 'This quote was cancelled.';
  if (f.status === 'rejected') return 'The customer rejected this quote.';
  if (f.status === 'expired' || f.expired) return 'This quote has expired. Revise it to give it a new date.';
  if (f.status !== 'sent' && f.status !== 'accepted') return 'Send the quote to the customer first. A draft or an unapproved quote cannot be converted.';
  if (!f.canApprove) return 'You do not have permission to convert quotes.';
  return null;
}

export function conversionChoices(f: ConversionFacts): ConversionChoice[] {
  const whole = quoteBlock(f);
  return QUOTE_TARGETS.map((target): ConversionChoice => {
    const words = TARGET_WORDS[target];
    const s = f.settings[target];
    const effects: string[] = [];
    const cautions: string[] = [];
    let reason: string | null = whole;

    if (reason === null && !f.can[target]) reason = `You do not have permission to create ${words.label.toLowerCase()}s.`;
    if (reason === null && f.customer?.blocked === true) reason = `${f.customer.name} is blocked from buying.`;
    if (reason === null && target !== 'cash_sale' && !f.addressComplete) reason = 'Add a complete delivery address to the quote first.';

    if (target === 'sales_order') {
      effects.push(`Creates a sales order for ${money(f.currency, f.total)}, at the prices on the quote.`);
      effects.push(stockWords(s));
      effects.push(s.invoice === 'with_document' ? 'The tax invoice is issued with the order.' : 'You raise the tax invoice later, from Sales Invoices.');
    }
    if (target === 'sales_invoice') {
      effects.push(`Issues a tax invoice for ${money(f.currency, f.total)}, at the prices on the quote.`);
      effects.push(stockWords(s));
      effects.push('The tax invoice is made now.');
    }
    if (target === 'credit_sale') {
      const c = f.customer;
      if (c?.hasCreditAccount !== true) reason ??= `${c?.name ?? 'This customer'} has no credit account. A credit sale needs one, so choose another way to sell, or give them a credit account first.`;
      effects.push(`Adds ${money(f.currency, f.total)} to ${c?.name ?? 'the customer'}’s account, at the prices on the quote.`);
      if (c?.hasCreditAccount === true) {
        effects.push(dueWords(s, c.termDays));
        if (s.creditCheck !== 'off' && c.available !== null) {
          if (f.total > c.available) {
            const over = f.total - c.available;
            if (s.overLimit === 'refuse') reason ??= `${c.name} has ${money(f.currency, Math.max(0, c.available))} of credit left, and this is ${money(f.currency, f.total)}. It is over their limit by ${money(f.currency, over)}.`;
            else cautions.push(`This is ${money(f.currency, over)} over ${c.name}’s credit limit. It will wait for approval before it goes through.`);
          } else effects.push(`Within their credit limit: ${money(f.currency, c.available)} available.`);
        }
        if (s.creditCheck === 'limit_and_overdue' && c.overdue) cautions.push(`${c.name} has an overdue invoice. The company’s rules may hold or refuse this sale.`);
      }
      effects.push(stockWords(s));
      effects.push(s.invoice === 'with_document' ? 'The tax invoice is issued now.' : 'You raise the tax invoice later, from Sales Invoices.');
    }
    if (target === 'cash_sale') {
      if (reason === null && f.deliveryFee > 0) reason = 'This quote includes a delivery charge. A cash sale is taken at the counter with no delivery, so make it a sales order or a sales invoice.';
      if (reason === null && !f.shiftOpen) reason = 'Open a shift on a till first. A cash sale is taken in your own open shift.';
      effects.push(`Takes ${money(f.currency, f.total)} now, in your open shift, at the prices on the quote.`);
      effects.push('You choose how the customer pays: cash, M-Pesa or card. Cash gives change.');
      effects.push('The stock leaves now. The customer’s receipt is the signed tax invoice.');
    }
    const approval = target === 'cash_sale' ? null : approvalWords(s);
    if (approval !== null) effects.push(approval);

    return { target, label: words.label, forWhen: words.forWhen, action: words.action, available: reason === null, reason, effects, cautions };
  });
}

/** A deterministic UUID from a quote id and a target, so a retried conversion of the same quote finds the sale it already made. */
export function conversionKey(quoteId: string, hash: (text: string) => string): string {
  const h = hash(`quote-cash-sale:${quoteId}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
