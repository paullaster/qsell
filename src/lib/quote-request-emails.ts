/** The mails about a quote a shopper asked for on the web shop: a confirmation to the shopper and an alert to the staff. Pure: the words only; sending is the server's. */

export const QUOTE_REQUEST_EMAIL_KINDS = ['shopper', 'staff'] as const;
export type QuoteRequestEmailKind = (typeof QUOTE_REQUEST_EMAIL_KINDS)[number];
export const isQuoteRequestEmailKind = (value: unknown): value is QuoteRequestEmailKind => typeof value === 'string' && (QUOTE_REQUEST_EMAIL_KINDS as readonly string[]).includes(value);

export interface QuoteRequestFacts {
  tradingName: string;
  quoteNumber: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  /** What was asked for, one line each: "12 × Express lunch: Large fish, Ugali and Sukuma". */
  lines: string[];
  /** The day it is needed (`YYYY-MM-DD`), or empty. */
  neededOn: string;
  /** What the shopper wrote, or empty. */
  message: string;
  /** The total as priced now, already formatted ("KES 7,440.00"). */
  total: string;
}

export interface QuoteRequestEmailContent {
  subject: string;
  heading: string;
  greeting: string;
  body: string;
  cta: string;
  details: [string, string][];
}

const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? '';

/** The words of one mail. The shopper's own words are shown as plain text; the sender escapes them. */
export function quoteRequestEmailContent(kind: QuoteRequestEmailKind, facts: QuoteRequestFacts): QuoteRequestEmailContent {
  const asked: [string, string][] = facts.lines.map((line, n) => [n === 0 ? 'Asked for' : '', line]);
  const when: [string, string][] = facts.neededOn === '' ? [] : [['Needed on', facts.neededOn]];
  if (kind === 'shopper') {
    const name = firstName(facts.customerName);
    return {
      subject: `We have your quote request ${facts.quoteNumber}`,
      heading: 'We have your quote request',
      greeting: name === '' ? 'Hello,' : `Hello ${name},`,
      body: `Thank you. We will check your request ${facts.quoteNumber} and send you the quote with the price. Nothing is ordered or charged until you accept it.`,
      cta: `Visit ${facts.tradingName}`,
      details: [['Request', facts.quoteNumber], ...asked, ...when, ['Price as it stands today', facts.total]],
    };
  }
  const contact: [string, string][] = [['Customer', facts.customerName], ...(facts.customerEmail === null || facts.customerEmail === '' ? [] : [['Email', facts.customerEmail] as [string, string]]), ...(facts.customerPhone === null || facts.customerPhone === '' ? [] : [['Phone', facts.customerPhone] as [string, string]])];
  return {
    subject: `New quote request ${facts.quoteNumber} from ${facts.customerName}`,
    heading: 'A shopper asked for a quote',
    greeting: 'Hello,',
    body: `${facts.customerName} asked for a quote on the web shop. It is waiting in Sales Quotes as a draft: check the price, send it, and when they accept it becomes an order.`,
    cta: 'Open Sales Quotes',
    details: [['Quote', facts.quoteNumber], ...contact, ...asked, ...when, ...(facts.message === '' ? [] : [['They wrote', facts.message] as [string, string]]), ['Total', facts.total]],
  };
}
