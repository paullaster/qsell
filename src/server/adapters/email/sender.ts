/**
 * Who a mail is from, worked out once for every message.
 *
 * Three identities are involved and mail servers disagree about them:
 *  - the mailbox: the account the server lets this instance send as (its login, or an address it owns). Always the envelope sender.
 *  - the From header: what the reader sees. Some servers only accept the mailbox here; others accept any address.
 *  - Reply-To: where an answer goes, which can be the business even when From is the mailbox.
 *
 * `mailbox` puts the mailbox in From, with the business's name as the display name, and the business address in Reply-To. It is
 * accepted by every server and is the default. `business` puts the business's own address in From and names the mailbox in the
 * Sender header and the envelope, for servers that allow it. Nothing here has a built-in address or name: what is missing is left out.
 */
export type FromPolicy = 'mailbox' | 'business';

export const FROM_POLICIES: readonly FromPolicy[] = ['mailbox', 'business'];

export const isFromPolicy = (value: string): value is FromPolicy => (FROM_POLICIES as readonly string[]).includes(value);

export interface SenderConfig {
  /** The address the mail server lets this instance send as. */
  mailbox: string;
  /** Display name for mail that does not name a business, such as account and vendor mail. */
  fromName: string | null;
  policy: FromPolicy;
}

/** The business a message speaks for, as the caller knows it (the company's trading name and its own address). */
export interface MessageSender {
  name?: string;
  address?: string;
}

export interface ResolvedSender {
  /** The From header. */
  from: string;
  /** The Sender header, set when From is not the mailbox so the server still sees who sent it. */
  sender: string | null;
  replyTo: string | null;
  /** The SMTP envelope sender: always the mailbox. */
  envelopeFrom: string;
}

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const MAX_ADDRESS = 254;
const MAX_NAME = 80;

/** A plain address with a real domain: `admin@localhost` and anything with spaces, brackets or line breaks is not one. */
export function isDeliverableAddress(value: string | null | undefined): value is string {
  if (value === null || value === undefined) return false;
  const trimmed = value.trim();
  return trimmed.length <= MAX_ADDRESS && ADDRESS.test(trimmed) && !trimmed.toLowerCase().endsWith('.localhost');
}

/** A display name that cannot break out of its header: no line breaks, quotes or angle brackets, and a sensible length. */
export function cleanDisplayName(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"<>\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME)
    .trim();
}

/** `"Name" <address>`, or the bare address when there is no name. */
export function formatAddress(name: string, address: string): string {
  return name === '' ? address : `"${name}" <${address}>`;
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export function resolveSender(config: SenderConfig, message: { sender?: MessageSender; replyTo?: string }): ResolvedSender {
  const businessAddress = isDeliverableAddress(message.sender?.address) ? message.sender.address.trim() : null;
  const businessName = cleanDisplayName(message.sender?.name);
  const name = businessName === '' ? cleanDisplayName(config.fromName) : businessName;
  const requestedReplyTo = isDeliverableAddress(message.replyTo) ? message.replyTo.trim() : null;

  if (config.policy === 'business' && businessAddress !== null) {
    return {
      from: formatAddress(name, businessAddress),
      sender: same(businessAddress, config.mailbox) ? null : config.mailbox,
      replyTo: requestedReplyTo,
      envelopeFrom: config.mailbox,
    };
  }

  const replyTo = requestedReplyTo ?? businessAddress;
  return {
    from: formatAddress(name, config.mailbox),
    sender: null,
    replyTo: replyTo !== null && same(replyTo, config.mailbox) ? null : replyTo,
    envelopeFrom: config.mailbox,
  };
}
