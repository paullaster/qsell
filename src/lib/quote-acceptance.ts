/**
 * What happens when a customer accepts a quote from their link, and what staff are told. Pure: the setting is read and checked here, and the
 * words of each notice are made here, so every channel (email, text, browser alert) says the same thing in the same way.
 */
import { TARGET_WORDS, type QuoteTarget } from './quote-conversion';

export const ACCEPTANCE_MODES = ['notify', 'sales_order', 'sales_invoice', 'credit_sale'] as const;
export type AcceptanceMode = (typeof ACCEPTANCE_MODES)[number];
export const isAcceptanceMode = (value: unknown): value is AcceptanceMode => typeof value === 'string' && (ACCEPTANCE_MODES as readonly string[]).includes(value);

/** A cash sale is never made on its own: it needs a person at a till to take the payment. */
export const AUTOMATIC_TARGETS: readonly Exclude<AcceptanceMode, 'notify'>[] = ['sales_order', 'sales_invoice', 'credit_sale'];

export interface AcceptanceSettings {
  onAcceptance: AcceptanceMode;
  notifyEmail: boolean;
  notifySms: boolean;
  notifyPush: boolean;
}

/** Until someone chooses, a customer's acceptance makes a sales order and tells the staff by email and browser alert, as it always has done for the order. */
export const DEFAULT_ACCEPTANCE: AcceptanceSettings = { onAcceptance: 'sales_order', notifyEmail: true, notifySms: false, notifyPush: true };

export const MODE_WORDS: Record<AcceptanceMode, { label: string; description: string }> = {
  notify: { label: 'Only tell my staff', description: 'The quote is marked accepted and the staff concerned are told. Nobody’s stock, invoice or account is touched until a person converts the quote and chooses what it becomes.' },
  sales_order: { label: 'Make a sales order', description: 'The quote becomes a sales order at once, at the quoted prices. Staff are told, and bill or deliver from there.' },
  sales_invoice: { label: 'Make a sales invoice', description: 'The quote becomes a sales invoice at once, with its tax invoice. Staff are told.' },
  credit_sale: { label: 'Make a credit sale', description: 'The quote is sold on the customer’s account at once. This needs a customer with a credit account; if they have none, the quote is left accepted and staff are told it needs them.' },
};

/** What was stored (or sent from the screen), made safe: anything unknown takes the default. */
export function readAcceptance(raw: unknown): AcceptanceSettings {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    onAcceptance: isAcceptanceMode(r.onAcceptance) ? r.onAcceptance : DEFAULT_ACCEPTANCE.onAcceptance,
    notifyEmail: typeof r.notifyEmail === 'boolean' ? r.notifyEmail : DEFAULT_ACCEPTANCE.notifyEmail,
    notifySms: typeof r.notifySms === 'boolean' ? r.notifySms : DEFAULT_ACCEPTANCE.notifySms,
    notifyPush: typeof r.notifyPush === 'boolean' ? r.notifyPush : DEFAULT_ACCEPTANCE.notifyPush,
  };
}

/** What the screen sent, for real: the mode must be one of the four and each channel a yes or no. */
export function checkAcceptance(raw: unknown): { ok: true; settings: AcceptanceSettings } | { ok: false; error: string } {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
  if (r === null) return { ok: false, error: 'The settings could not be read.' };
  if (!isAcceptanceMode(r.onAcceptance)) return { ok: false, error: 'Choose what happens when a customer accepts a quote.' };
  for (const key of ['notifyEmail', 'notifySms', 'notifyPush'] as const) if (typeof r[key] !== 'boolean') return { ok: false, error: 'Choose how staff are told, for each way.' };
  return { ok: true, settings: { onAcceptance: r.onAcceptance, notifyEmail: r.notifyEmail as boolean, notifySms: r.notifySms as boolean, notifyPush: r.notifyPush as boolean } };
}

/** What became of the quote when the customer accepted it. */
export type AcceptanceOutcome =
  | { kind: 'converted'; target: QuoteTarget; number: string; invoiceNumber: string | null; waitingForApproval: boolean }
  | { kind: 'waiting' }
  | { kind: 'failed'; target: AcceptanceMode; reason: string };

export interface AcceptanceFacts {
  quoteNumber: string;
  customerName: string;
  total: string;
  currency: string;
  shop: string;
  /** Where staff open the quote, as an address on this site ("/admin/quotes"). */
  path: string;
  /** The full address, when the site's own address is known. */
  link: string;
  outcome: AcceptanceOutcome;
}

export interface AcceptanceNotice {
  subject: string;
  text: string;
  html: string;
  sms: string;
  push: { title: string; body: string; url: string; tag: string };
}

const esc = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const money = (currency: string, total: string): string => `${currency} ${Number(total).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What happened, and what the staff member is to do, in one sentence each. */
export function acceptanceSentences(f: AcceptanceFacts): { what: string; next: string } {
  const o = f.outcome;
  const who = `${f.customerName} accepted quotation ${f.quoteNumber} for ${money(f.currency, f.total)}.`;
  if (o.kind === 'converted') {
    const made = TARGET_WORDS[o.target].made.toLowerCase();
    const invoice = o.invoiceNumber === null ? '' : ` Its tax invoice is ${o.invoiceNumber}.`;
    const approval = o.waitingForApproval ? ' It is waiting for approval.' : '';
    return { what: `${who} It became ${made} ${o.number}.${invoice}${approval}`, next: o.waitingForApproval ? 'Approve it so it can go ahead.' : 'Nothing is needed unless you want to change it.' };
  }
  if (o.kind === 'failed') {
    return { what: `${who} It could not be made into ${TARGET_WORDS[o.target as QuoteTarget].made.toLowerCase()} automatically: ${o.reason}`, next: 'Open the quote and convert it yourself, choosing what it becomes.' };
  }
  return { what: who, next: 'Open the quote and choose what it becomes: a sales order, a sales invoice, a credit sale or a cash sale.' };
}

export function acceptanceNotice(f: AcceptanceFacts): AcceptanceNotice {
  const { what, next } = acceptanceSentences(f);
  const needsYou = f.outcome.kind !== 'converted' || f.outcome.waitingForApproval;
  const subject = `${f.customerName} accepted quotation ${f.quoteNumber}${needsYou ? ': action needed' : ''}`;
  const link = f.link === '' ? '' : `\n\nOpen the quote: ${f.link}`;
  const html = `<div style="font-family:Arial,sans-serif;color:#111827"><h2>${esc(f.shop)}</h2><p>${esc(what)}</p><p><strong>${esc(next)}</strong></p>${f.link === '' ? '' : `<p><a href="${esc(f.link)}">Open the quote</a></p>`}</div>`;
  // A text message is short and has no link to lean on: who, which quote, how much, and whether it needs the reader.
  const sms = `${f.shop}: ${f.customerName} accepted ${f.quoteNumber} (${money(f.currency, f.total)}).${needsYou ? ' Needs your action.' : ''}`.slice(0, 300);
  return {
    subject,
    text: `${what}\n\n${next}${link}`,
    html,
    sms,
    push: { title: needsYou ? `Quote accepted: action needed` : 'Quote accepted', body: `${f.customerName} accepted ${f.quoteNumber} for ${money(f.currency, f.total)}.`, url: f.path, tag: `quote-accepted-${f.quoteNumber}` },
  };
}
