import type { DeliveryAction } from './delivery-document';

/** The messages a customer gets as their delivery moves. Pure: the words and the rules; the sending is the server's. */
export const MESSAGE_KINDS = ['out_for_delivery', 'delivered', 'part_delivered', 'attempt_failed', 'returned', 'slot_not_kept', 'ready_for_collection', 'collection_reminder'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export const isMessageKind = (value: unknown): value is MessageKind => typeof value === 'string' && (MESSAGE_KINDS as readonly string[]).includes(value);

/** Which message, if any, a delivery step sends. `whole` is whether the order is now delivered in full, for a delivery that arrived. */
export function kindForStep(action: DeliveryAction, whole: boolean): MessageKind | null {
  if (action === 'deliver') return whole ? 'delivered' : 'part_delivered';
  return SENT_BY_STEP[action] ?? null;
}

const SENT_BY_STEP: Partial<Record<DeliveryAction, MessageKind>> = { dispatch: 'out_for_delivery', fail_attempt: 'attempt_failed', return: 'returned' };

/** What each message is, for the shop's own list of what was sent. */
export const KIND_WORDS: Record<MessageKind, string> = { out_for_delivery: 'On its way', delivered: 'Delivered', part_delivered: 'Part delivered', attempt_failed: 'Could not deliver', returned: 'Coming back to us', slot_not_kept: 'Chosen time not kept', ready_for_collection: 'Ready to collect', collection_reminder: 'Still waiting to be collected' };

/** One message for one thing that happened, however often the step is retried: the same key is the same message. */
export const messageKey = (deliveryId: string, kind: MessageKind, attempt: number): string => `${deliveryId}:${kind}:${String(attempt)}`;

/** Why a delivery did not happen, in words for the customer (not the dispatcher's wording). */
const REASON_FOR_CUSTOMER: Record<string, string> = {
  customer_absent: 'nobody was there to receive it',
  refused: 'it was not accepted at the door',
  wrong_address: 'we could not find the address',
  unreachable: 'we could not reach you by phone',
  damaged: 'the goods were damaged on the way and need replacing',
  not_safe: 'we could not reach the place safely',
  other: 'something prevented the delivery',
};
export const reasonForCustomer = (code: string | null): string => (code !== null && Object.prototype.hasOwnProperty.call(REASON_FOR_CUSTOMER, code) ? (REASON_FOR_CUSTOMER[code] ?? REASON_FOR_CUSTOMER.other ?? '') : (REASON_FOR_CUSTOMER.other ?? ''));

export interface MessageFacts {
  tradingName: string;
  /** The first word of the customer's name, or empty. */
  firstName: string;
  orderNumber: string;
  deliveryNumber: string;
  /** The customer's own tracking page. */
  trackUrl: string;
  courierName: string | null;
  receivedBy: string | null;
  /** The six digits the customer says at the door, when the company asks for them as proof. Only the "on its way" message carries it. */
  handoverCode: string | null;
  reasonCode: string | null;
  /** How many tries are left, when a delivery failed and can be tried again. */
  triesLeft: number | null;
  /** For an order collected from a branch: where, and the code to show at the counter (as the customer reads it). Null for a delivery. */
  collection: { branchName: string; code: string; /** True when this is a new code sent after the first one, so the old one no longer works. */ renewed?: boolean; /** For the reminder: whole days the order has been waiting. */ waitingDays?: number; /** The last reminder we send. */ lastReminder?: boolean } | null;
}

export interface MessageContent {
  subject: string;
  heading: string;
  greeting: string;
  body: string;
  details: readonly (readonly [string, string])[];
  cta: string;
}

/**
 * The words of a message. It carries only what the tracking page shows: the order and delivery numbers, the state, and (for a
 * courier) the courier's name. Never an address, a phone number or a payment detail.
 */
export function messageContent(kind: MessageKind, f: MessageFacts): MessageContent {
  const store = f.tradingName.trim() === '' ? 'the shop' : f.tradingName.trim();
  const greeting = f.firstName.trim() === '' ? 'Hello,' : `Hello ${f.firstName.trim()},`;
  const base: readonly (readonly [string, string])[] = [['Order', f.orderNumber], ['Delivery', f.deliveryNumber]];
  const withCourier = f.courierName === null ? base : [...base, ['Courier', f.courierName] as const];
  switch (kind) {
    case 'out_for_delivery':
      return {
        subject: `Your order ${f.orderNumber} is on its way · ${store}`,
        heading: 'Your order is on its way',
        greeting,
        body: `Your delivery has left us and is on its way to you. You can follow it on your tracking page.${f.handoverCode === null ? '' : ' Please give the rider the delivery code below when it arrives, and only then.'}`,
        details: f.handoverCode === null ? withCourier : [...withCourier, ['Delivery code', f.handoverCode] as const],
        cta: 'Track my delivery',
      };
    case 'delivered':
      return { subject: `Your order ${f.orderNumber} was delivered · ${store}`, heading: 'Your order was delivered', greeting, body: f.receivedBy === null ? 'Your order was delivered. Thank you for shopping with us.' : `Your order was delivered and ${f.receivedBy} received it. Thank you for shopping with us.`, details: base, cta: 'See my delivery' };
    case 'part_delivered':
      return { subject: `Part of your order ${f.orderNumber} was delivered · ${store}`, heading: 'Part of your order was delivered', greeting, body: 'Part of your order has been delivered. The rest will follow on another delivery, and you will hear from us when it leaves.', details: base, cta: 'See my delivery' };
    case 'attempt_failed':
      return { subject: `We could not deliver your order ${f.orderNumber} · ${store}`, heading: 'We could not deliver your order', greeting, body: `We tried to deliver your order, but ${reasonForCustomer(f.reasonCode)}.${f.triesLeft !== null && f.triesLeft > 0 ? ' We will try again; please keep your phone on.' : ' Please contact us so we can arrange it.'}`, details: base, cta: 'See my delivery' };
    case 'slot_not_kept':
      return {
        subject: `About the delivery time for your order ${f.orderNumber} · ${store}`,
        heading: 'We could not keep the delivery time you chose',
        greeting,
        body: 'The delivery time you chose for your order has since been taken or closed, so we could not hold it for you. Your order is still going ahead. We will be in touch to agree another time, and you can follow it on your tracking page.',
        details: base,
        cta: 'Track my delivery',
      };
    case 'ready_for_collection': {
      const at = f.collection;
      return {
        subject: at?.renewed === true ? `A new collection code for order ${f.orderNumber} · ${store}` : `Your order ${f.orderNumber} is ready to collect · ${store}`,
        heading: at?.renewed === true ? 'Your new collection code' : 'Your order is ready to collect',
        greeting,
        body: at?.renewed === true ? `You have a new collection code for your order at ${at.branchName}. The code we sent before no longer works. Show this one at the counter, and only there: whoever has the code can collect the order.` : `Your order is packed and waiting for you${at === null ? '' : ` at ${at.branchName}`}. Show the collection code below at the counter, and only there: whoever has the code can collect the order.`,
        details: at === null ? [['Order', f.orderNumber]] : [['Order', f.orderNumber], ['Collect from', at.branchName], ['Collection code', at.code]],
        cta: 'See my order',
      };
    }
    case 'collection_reminder': {
      const at = f.collection;
      const days = at?.waitingDays ?? 0;
      return {
        subject: `Your order ${f.orderNumber} is still waiting for you · ${store}`,
        heading: 'Your order is still waiting for you',
        greeting,
        body: `Your order has been packed and waiting${at === null ? '' : ` at ${at.branchName}`} for ${String(days)} ${days === 1 ? 'day' : 'days'}. Please come and collect it${at?.lastReminder === true ? ', as this is the last reminder we will send' : ''}. Show the collection code below at the counter, and only there: whoever has the code can collect the order.`,
        details: at === null ? [['Order', f.orderNumber]] : [['Order', f.orderNumber], ['Collect from', at.branchName], ['Collection code', at.code]],
        cta: 'See my order',
      };
    }
    case 'returned':
      return { subject: `Your order ${f.orderNumber} is coming back to us · ${store}`, heading: 'We could not deliver, and it is coming back to us', greeting, body: 'We were not able to deliver your order and it is being returned to us. Please contact us so we can arrange another delivery or put it right.', details: base, cta: 'See my delivery' };
  }
}

/** The messages a company may choose to also send by text, with the words the settings screen uses and which are on when texting is first turned on. */
export const TEXT_KIND_CHOICES: readonly { kind: MessageKind; label: string; hint: string; onByDefault: boolean }[] = [
  { kind: 'out_for_delivery', label: 'On its way', hint: 'Carries the delivery code the customer gives the rider, when the shop asks for one.', onByDefault: true },
  { kind: 'delivered', label: 'Delivered', hint: 'Says who received it.', onByDefault: true },
  { kind: 'part_delivered', label: 'Part delivered', hint: 'Says the rest will follow.', onByDefault: false },
  { kind: 'attempt_failed', label: 'Could not deliver', hint: 'Says why, and how many tries are left.', onByDefault: true },
  { kind: 'returned', label: 'Coming back to us', hint: 'Says the order is being returned.', onByDefault: false },
  { kind: 'slot_not_kept', label: 'Delivery time not kept', hint: 'Says the chosen time could not be held.', onByDefault: false },
  { kind: 'ready_for_collection', label: 'Ready to collect', hint: 'For orders collected from a branch: says where, and carries the collection code to show at the counter. Also covers a new code and the reminder for an order not yet collected.', onByDefault: true },
];

export type TextKindsInput = { ok: true; kinds: MessageKind[] } | { ok: false; error: string };

/** The kinds ticked on the screen: only known kinds, once each, in the usual order. */
export function readTextKinds(raw: unknown): TextKindsInput {
  if (!Array.isArray(raw)) return { ok: false, error: 'Choose which messages are also texted.' };
  const wanted = new Set<string>();
  for (const k of raw) {
    // Only the choices on the screen: a message that follows another (the reminder) is not a choice of its own.
    if (!isMessageKind(k) || !TEXT_KIND_CHOICES.some((c) => c.kind === k)) return { ok: false, error: 'One of the messages chosen is not one we send.' };
    wanted.add(k);
  }
  return { ok: true, kinds: TEXT_KIND_CHOICES.map((c) => c.kind).filter((k) => wanted.has(k)) };
}

/**
 * The text-message version of a message: short, in plain words, with the tracking link last. It carries only what the email carries
 * (the order and delivery numbers, the state, the courier, the delivery code), never an address, a phone number or a payment detail. It is
 * kept to two message parts (306 characters) by shortening the shop's name and then the reason before the link is touched.
 */
export function textContent(kind: MessageKind, f: MessageFacts): string {
  const store = f.tradingName.trim();
  const hello = f.firstName.trim() === '' ? 'Hello,' : `Hello ${f.firstName.trim()},`;
  const order = `order ${f.orderNumber}`;
  const link = `Track: ${f.trackUrl}`;
  const build = (shop: string): string => {
    switch (kind) {
      case 'out_for_delivery':
        return `${hello} your ${shop}${order} is on its way.${f.handoverCode === null ? '' : ` Give the rider code ${f.handoverCode} when it arrives, and only then.`} ${link}`;
      case 'delivered':
        return `${hello} your ${shop}${order} was delivered${f.receivedBy === null ? '' : ` and received by ${f.receivedBy}`}. Thank you. ${link}`;
      case 'part_delivered':
        return `${hello} part of your ${shop}${order} was delivered. The rest will follow. ${link}`;
      case 'attempt_failed':
        return `${hello} we could not deliver your ${shop}${order}: ${reasonForCustomer(f.reasonCode)}.${f.triesLeft !== null && f.triesLeft > 0 ? ` We will try again (${String(f.triesLeft)} ${f.triesLeft === 1 ? 'try' : 'tries'} left).` : ''} ${link}`;
      case 'ready_for_collection':
        if (f.collection?.renewed === true) return `${hello} your ${shop}${order} has a new collection code: ${f.collection.code}. The old one no longer works. Show it at ${f.collection.branchName}, and only there. ${link}`;
        return `${hello} your ${shop}${order} is ready to collect${f.collection === null ? '' : ` at ${f.collection.branchName}`}.${f.collection === null ? '' : ` Show code ${f.collection.code} at the counter, and only there.`} ${link}`;
      case 'collection_reminder':
        return `${hello} your ${shop}${order} is still waiting${f.collection === null ? '' : ` at ${f.collection.branchName}`}.${f.collection === null ? '' : ` Show code ${f.collection.code} at the counter, and only there.`} ${link}`;
      case 'returned':
        return `${hello} we could not deliver your ${shop}${order} and it is coming back to us. ${link}`;
      case 'slot_not_kept':
        return `${hello} we could not keep the delivery time you chose for your ${shop}${order}. We will agree another time with you. ${link}`;
    }
  };
  const named = (name: string): string => (name === '' ? '' : `${name} `);
  const full = build(named(store));
  if (full.length <= 306) return full;
  const short = build(named(store.slice(0, 20).trim()));
  return short.length <= 306 ? short : build('');
}

/** Hours when customers are not texted, as minutes after midnight in the business's time: from the first, up to (not including) the second. */
export interface QuietHours {
  from: number;
  until: number;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const minutesToClock = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export type QuietHoursInput = { ok: true; quiet: QuietHours | null } | { ok: false; error: string };

/** Quiet hours as typed (two times like 21:00 and 07:00), or none when both are empty. One time without the other, or the same time twice, is refused. */
export function readQuietHours(from: unknown, until: unknown): QuietHoursInput {
  const blank = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  if (blank(from) && blank(until)) return { ok: true, quiet: null };
  const a = typeof from === 'string' ? HHMM.exec(from.trim()) : null;
  const b = typeof until === 'string' ? HHMM.exec(until.trim()) : null;
  if (a === null || b === null) return { ok: false, error: 'Give both quiet hours as times like 21:00 and 07:00, or leave both empty.' };
  const f = Number(a[1]) * 60 + Number(a[2]);
  const u = Number(b[1]) * 60 + Number(b[2]);
  if (f === u) return { ok: false, error: 'The quiet hours start and end at the same time. Change one, or leave both empty.' };
  return { ok: true, quiet: { from: f, until: u } };
}

export interface CollectionReminders {
  enabled: boolean;
  /** Whole days after the order was marked ready. */
  firstDays: number;
  /** Whole days after it was marked ready, for the last reminder; null when there is only one. */
  secondDays: number | null;
}
export const DEFAULT_REMINDERS: CollectionReminders = { enabled: true, firstDays: 3, secondDays: 6 };
export type RemindersInput = { ok: true; reminders: CollectionReminders } | { ok: false; error: string };

const wholeDays = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  return typeof v === 'string' && /^\d{1,3}$/.test(v.trim()) ? Number(v.trim()) : null;
};

/** The reminder settings as typed: a first reminder of 1 to 30 days, and an optional last one later than it, up to 60 days. Empty for the last one means there is only one reminder. */
export function readReminders(enabled: unknown, first: unknown, second: unknown): RemindersInput {
  const firstDays = wholeDays(first);
  if (firstDays === null || firstDays < 1 || firstDays > 30) return { ok: false, error: 'Give the days before the first reminder as a whole number from 1 to 30.' };
  const blank = second === undefined || second === null || (typeof second === 'string' && second.trim() === '');
  if (blank) return { ok: true, reminders: { enabled: enabled === true, firstDays, secondDays: null } };
  const secondDays = wholeDays(second);
  if (secondDays === null || secondDays <= firstDays || secondDays > 60) return { ok: false, error: 'The last reminder must come later than the first, at most 60 days after the order was ready. Leave it empty to send only one.' };
  return { ok: true, reminders: { enabled: enabled === true, firstDays, secondDays } };
}

/** When a text due `now` may go, if `now` falls in the quiet hours (the next time they end, on the minute); null when it may go now. */
export function quietEndsAt(now: Date, quiet: QuietHours | null, timeZone: string): Date | null {
  if (quiet === null) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const num = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const m = num('hour') * 60 + num('minute');
  const inside = quiet.from < quiet.until ? m >= quiet.from && m < quiet.until : m >= quiet.from || m < quiet.until;
  if (!inside) return null;
  const wait = (quiet.until - m + 1440) % 1440;
  return new Date(now.getTime() - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds() + wait * 60000);
}
