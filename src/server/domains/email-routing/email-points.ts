import type { RouteConfig } from './email-routes';

/** A place the system writes a mail (or prints business emails on a document). A deployment configures points; it does not add them. */
export interface EmailPoint {
  key: EmailPointKey;
  label: string;
  description: string;
  /** `mail` is sent; `document` is the list of business emails printed on a quote. */
  kind: 'mail' | 'document';
  /** What happens with no configuration at all: today's behaviour. */
  defaults: RouteConfig;
  /** The sources that mean something here (a quote document has no "customer"). */
  context: { customer: boolean; actor: boolean; owner: boolean };
}

export const EMAIL_POINT_KEYS = [
  'shop_quote_request_staff',
  'shop_quote_request_customer',
  'quote_sent',
  'quote_accepted_staff',
  'shop_order_placed_customer',
  'shop_order_paid_customer',
  'shop_order_placed_staff',
  'shop_order_paid_staff',
  'quote_document_shop',
  'quote_document_staff',
] as const;
export type EmailPointKey = (typeof EMAIL_POINT_KEYS)[number];
export const isEmailPointKey = (value: unknown): value is EmailPointKey => typeof value === 'string' && (EMAIL_POINT_KEYS as readonly string[]).includes(value);

const NONE: RouteConfig = { enabled: true, to: [], cc: [], bcc: [], replyTo: [], shown: [] };
const toCompany: RouteConfig = { ...NONE, to: [{ kind: 'company' }] };
const toCustomer: RouteConfig = { ...NONE, to: [{ kind: 'customer' }] };
const shown: RouteConfig = { ...NONE, shown: [{ kind: 'company' }] };

export const EMAIL_POINTS: readonly EmailPoint[] = [
  { key: 'shop_quote_request_staff', label: 'Web shop quote request: alert to staff', description: 'When a shopper asks for a quote on the web shop.', kind: 'mail', defaults: toCompany, context: { customer: true, actor: false, owner: false } },
  { key: 'shop_quote_request_customer', label: 'Web shop quote request: confirmation to the shopper', description: 'The confirmation the shopper gets after asking for a quote.', kind: 'mail', defaults: toCustomer, context: { customer: true, actor: false, owner: false } },
  { key: 'quote_sent', label: 'Quote sent to the customer', description: 'The email staff send from Sales Quotes (Send via Email), for quotes made by staff and for requests from the web shop.', kind: 'mail', defaults: { ...toCustomer, replyTo: [{ kind: 'company' }] }, context: { customer: true, actor: true, owner: true } },
  { key: 'quote_accepted_staff', label: 'Quote accepted by the customer: alert to staff', description: 'When a customer accepts a quote from the link in their email. Text messages and browser alerts for it go to the staff accounts chosen here, and to whoever sent the quote.', kind: 'mail', defaults: { ...NONE, to: [{ kind: 'owner' }] }, context: { customer: true, actor: false, owner: true } },
  { key: 'shop_order_placed_customer', label: 'Web shop order placed: mail to the shopper', description: 'The "we have your order" mail.', kind: 'mail', defaults: toCustomer, context: { customer: true, actor: false, owner: false } },
  { key: 'shop_order_paid_customer', label: 'Web shop order paid: mail to the shopper', description: 'The "payment received" mail.', kind: 'mail', defaults: toCustomer, context: { customer: true, actor: false, owner: false } },
  { key: 'shop_order_placed_staff', label: 'Web shop order placed: alert to staff', description: 'Tells your team an order was placed. Off until you choose who is told.', kind: 'mail', defaults: { ...NONE, enabled: false }, context: { customer: true, actor: false, owner: false } },
  { key: 'shop_order_paid_staff', label: 'Web shop order paid: alert to staff', description: 'Tells your team an order was paid. Off until you choose who is told.', kind: 'mail', defaults: { ...NONE, enabled: false }, context: { customer: true, actor: false, owner: false } },
  { key: 'quote_document_shop', label: 'Business emails shown on quotes asked for on the web shop', description: 'The "Questions? Contact …" emails printed on the quote document, on the public quote page and in the quote email.', kind: 'document', defaults: shown, context: { customer: false, actor: false, owner: false } },
  { key: 'quote_document_staff', label: 'Business emails shown on quotes made by staff', description: 'The "Questions? Contact …" emails printed on the quote document, on the public quote page and in the quote email.', kind: 'document', defaults: shown, context: { customer: false, actor: true, owner: true } },
];

export function pointOf(key: EmailPointKey): EmailPoint {
  const found = EMAIL_POINTS.find((p) => p.key === key);
  if (found === undefined) throw new Error(`No such email point: ${key}`);
  return found;
}
