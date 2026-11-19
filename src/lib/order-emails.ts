/** The mails a shopper gets about their order: placed, and payment received. Pure: the words and the rules; the sending is the server's. */

export const ORDER_EMAIL_KINDS = ['placed', 'paid'] as const;
export type OrderEmailKind = (typeof ORDER_EMAIL_KINDS)[number];
export const isOrderEmailKind = (value: unknown): value is OrderEmailKind => typeof value === 'string' && (ORDER_EMAIL_KINDS as readonly string[]).includes(value);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The address to write to, or null when the order has none that can be right (the shopper may leave it out). */
export const usableEmail = (value: string | null | undefined): string | null => {
  const address = (value ?? '').trim().toLowerCase();
  return EMAIL.test(address) ? address : null;
};

export interface OrderEmailFacts {
  tradingName: string;
  customerName: string;
  orderNumber: string;
  /** Each line as the shopper bought it: its name, how many, and what it came to. */
  lines: { name: string; quantity: string; amount: string }[];
  subtotal: string;
  tax: string;
  shipping: string | null;
  total: string;
  /** How the order is to be paid or was paid, in words. */
  paymentWords: string;
  /** The payment reference the provider gave, when there is one. */
  reference: string | null;
  /** On account or pay on delivery: nothing is due now. */
  payLater: 'account' | 'door' | null;
  trackUrl: string;
}

export interface OrderEmailContent {
  subject: string;
  heading: string;
  greeting: string;
  body: string;
  cta: string;
  details: [string, string][];
}

const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? '';

export function orderEmailContent(kind: OrderEmailKind, f: OrderEmailFacts): OrderEmailContent {
  const hello = firstName(f.customerName) === '' ? 'Hello,' : `Hello ${firstName(f.customerName)},`;
  const lines: [string, string][] = f.lines.map((l) => [`${l.quantity} × ${l.name}`, l.amount]);
  const money: [string, string][] = [['Subtotal', f.subtotal], ['Tax', f.tax], ...(f.shipping === null ? [] : ([['Delivery', f.shipping]] as [string, string][])), ['Total', f.total]];
  if (kind === 'paid') {
    return {
      subject: `Payment received for order ${f.orderNumber}`,
      heading: 'We have received your payment',
      greeting: hello,
      body: `Thank you. Your payment for order ${f.orderNumber} was received and ${f.tradingName} is getting your order ready.`,
      cta: 'Follow your order',
      details: [['Order', f.orderNumber], ...(f.reference === null ? [] : ([['Payment reference', f.reference]] as [string, string][])), ['Paid by', f.paymentWords], ...lines, ...money],
    };
  }
  let body = `Thank you for ordering from ${f.tradingName}. We have your order ${f.orderNumber} and are holding the items for you.`;
  if (f.payLater === 'door') body += ' You pay when it arrives: please have the amount ready.';
  else if (f.payLater === 'account') body += ' It has been added to your account.';
  else body += ' It is confirmed when your payment is received, and we will write to you then.';
  return {
    subject: `We have your order ${f.orderNumber}`,
    heading: 'We have your order',
    greeting: hello,
    body,
    cta: 'Follow your order',
    details: [['Order', f.orderNumber], ['Payment', f.paymentWords], ...lines, ...money],
  };
}

export interface StaffOrderEmailFacts extends OrderEmailFacts {
  customerEmail: string | null;
  customerPhone: string | null;
}

/** The alert to the company's own people that a web shop order was placed or paid: who, how to reach them, what and how much. */
export function staffOrderEmailContent(kind: OrderEmailKind, f: StaffOrderEmailFacts): OrderEmailContent {
  const lines: [string, string][] = f.lines.map((l) => [`${l.quantity} × ${l.name}`, l.amount]);
  const who = f.customerName.trim() === '' ? 'A shopper' : f.customerName.trim();
  const contact: [string, string][] = [
    ['Customer', who],
    ...(f.customerEmail === null || f.customerEmail === '' ? [] : ([['Email', f.customerEmail]] as [string, string][])),
    ...(f.customerPhone === null || f.customerPhone === '' ? [] : ([['Phone', f.customerPhone]] as [string, string][])),
  ];
  if (kind === 'paid') {
    return {
      subject: `Order ${f.orderNumber} is paid (${f.total})`,
      heading: 'An order was paid',
      greeting: 'Hello,',
      body: `${who} paid for order ${f.orderNumber} on the web shop. It is ready to be prepared.`,
      cta: 'Open Web Shop Orders',
      details: [['Order', f.orderNumber], ...contact, ['Paid by', f.paymentWords], ...(f.reference === null ? [] : ([['Payment reference', f.reference]] as [string, string][])), ...lines, ['Total', f.total]],
    };
  }
  const paymentWords = { door: 'To be paid at the door.', account: 'On the customer\'s account.' };
  const payment = f.payLater === null ? 'Waiting for payment.' : paymentWords[f.payLater];
  return {
    subject: `New web shop order ${f.orderNumber} from ${who}`,
    heading: 'A new order was placed',
    greeting: 'Hello,',
    body: `${who} placed order ${f.orderNumber} on the web shop. ${payment}`,
    cta: 'Open Web Shop Orders',
    details: [['Order', f.orderNumber], ...contact, ['Payment', f.paymentWords], ...lines, ['Total', f.total]],
  };
}
