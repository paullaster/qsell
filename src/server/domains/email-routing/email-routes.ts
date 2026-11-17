import { isDeliverableAddress } from '@/server/adapters/email/sender';

/**
 * Who a business mail is written to, and which business emails a quote shows. Pure: the rules only. A recipient is a *source*, a way of
 * finding an address when the mail is sent, so a change in Company Setup or in a person's account is followed without editing anything.
 */
export type RouteSource =
  | { kind: 'staff'; userId: string }
  | { kind: 'company' }
  | { kind: 'channel'; channelId: string }
  | { kind: 'customer' }
  | { kind: 'actor' }
  | { kind: 'owner' }
  | { kind: 'address'; address: string };

export type SourceKind = RouteSource['kind'];
export const SOURCE_KINDS: readonly SourceKind[] = ['staff', 'company', 'channel', 'customer', 'actor', 'owner', 'address'];

export const LIST_NAMES = ['to', 'cc', 'bcc', 'replyTo', 'shown'] as const;
export type ListName = (typeof LIST_NAMES)[number];

export interface RouteConfig {
  /** Off: nothing is sent (the reason is logged). */
  enabled: boolean;
  to: RouteSource[];
  cc: RouteSource[];
  bcc: RouteSource[];
  replyTo: RouteSource[];
  /** The business emails a quote document shows (quote document points only). */
  shown: RouteSource[];
}

export const ROUTE_LIMIT = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One source from what was stored or sent; null when it is not one. */
export function parseSource(raw: unknown): RouteSource | null {
  if (!isRecord(raw)) return null;
  const { kind } = raw;
  if (kind === 'staff') return typeof raw.userId === 'string' && UUID.test(raw.userId) ? { kind, userId: raw.userId.toLowerCase() } : null;
  if (kind === 'channel') return typeof raw.channelId === 'string' && raw.channelId.length > 0 && raw.channelId.length <= 64 ? { kind, channelId: raw.channelId } : null;
  if (kind === 'address') return typeof raw.address === 'string' && isDeliverableAddress(raw.address) ? { kind, address: raw.address.trim() } : null;
  if (kind === 'company' || kind === 'customer' || kind === 'actor' || kind === 'owner') return { kind };
  return null;
}

export const sourceKey = (source: RouteSource): string => {
  switch (source.kind) {
    case 'staff':
      return `staff:${source.userId}`;
    case 'channel':
      return `channel:${source.channelId}`;
    case 'address':
      return `address:${source.address.toLowerCase()}`;
    case 'company':
    case 'customer':
    case 'actor':
    case 'owner':
      return source.kind;
  }
};

/** A list of sources from what was stored or sent: only real ones, each once, at most the limit. */
export const readSources = (raw: unknown): RouteSource[] => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: RouteSource[] = [];
  for (const entry of raw.slice(0, ROUTE_LIMIT * 2)) {
    const source = parseSource(entry);
    if (source === null || seen.has(sourceKey(source))) continue;
    seen.add(sourceKey(source));
    out.push(source);
    if (out.length >= ROUTE_LIMIT) break;
  }
  return out;
};

/**
 * What was stored, made safe: an unreadable row, a list that is not a list or a source that is not one never breaks a send. A list
 * that is missing takes the default; a list that is there (even empty) is kept as it is.
 */
export function readRouteConfig(raw: unknown, defaults: RouteConfig): RouteConfig {
  if (!isRecord(raw)) return defaults;
  const list = (name: ListName): RouteSource[] => (Array.isArray(raw[name]) ? readSources(raw[name]) : defaults[name]);
  return { enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled, to: list('to'), cc: list('cc'), bcc: list('bcc'), replyTo: list('replyTo'), shown: list('shown') };
}

export type CheckedRoute = { ok: true; config: RouteConfig } | { ok: false; error: string };

/** What the screen sent, for real: each source must be one, each address must be deliverable, lists are bounded, and a mail that is on needs someone to write to. */
export function checkRouteInput(raw: unknown, kind: 'mail' | 'document'): CheckedRoute {
  if (!isRecord(raw)) return { ok: false, error: 'The settings could not be read.' };
  const lists: Partial<Record<ListName, RouteSource[]>> = {};
  for (const name of LIST_NAMES) {
    const given = raw[name];
    if (given === undefined) {
      lists[name] = [];
      continue;
    }
    if (!Array.isArray(given)) return { ok: false, error: 'A list of people could not be read.' };
    if (given.length > ROUTE_LIMIT) return { ok: false, error: `A list can have at most ${String(ROUTE_LIMIT)} entries.` };
    const kept: RouteSource[] = [];
    const seen = new Set<string>();
    for (const entry of given) {
      const source = parseSource(entry);
      if (source === null) return { ok: false, error: isRecord(entry) && entry.kind === 'address' ? `That address does not look right: ${typeof entry.address === 'string' ? entry.address.slice(0, 80) : ''}` : 'One of the entries could not be read.' };
      if (seen.has(sourceKey(source))) continue;
      seen.add(sourceKey(source));
      kept.push(source);
    }
    lists[name] = kept;
  }
  const config: RouteConfig = { enabled: raw.enabled !== false, to: lists.to ?? [], cc: lists.cc ?? [], bcc: lists.bcc ?? [], replyTo: lists.replyTo ?? [], shown: lists.shown ?? [] };
  if (kind === 'document') return { ok: true, config: { ...config, enabled: true, to: [], cc: [], bcc: [], replyTo: [] } };
  if (config.enabled && config.to.length === 0) return { ok: false, error: 'Choose who it is sent to, or switch it off.' };
  return { ok: true, config: { ...config, shown: [] } };
}

/** What the sender must load before resolving: the staff accounts and the support channels the lists name, with the people on the document. */
export function idsNeeded(config: RouteConfig, context: { actorUserId: string | null; ownerUserId: string | null }): { staff: string[]; channels: string[] } {
  const staff = new Set<string>();
  const channels = new Set<string>();
  for (const name of LIST_NAMES) {
    for (const source of config[name]) {
      if (source.kind === 'staff') staff.add(source.userId);
      else if (source.kind === 'channel') channels.add(source.channelId);
      else if (source.kind === 'actor' && context.actorUserId !== null) staff.add(context.actorUserId);
      else if (source.kind === 'owner' && context.ownerUserId !== null) staff.add(context.ownerUserId);
    }
  }
  return { staff: [...staff], channels: [...channels] };
}

export interface ResolveContext {
  customerEmail: string | null;
  companyEmail: string | null;
  /** Support channel id to its email, for the email channels only. */
  channelEmails: ReadonlyMap<string, string>;
  /** Staff account id to its email, for accounts that are active. */
  staffEmails: ReadonlyMap<string, string>;
  actorUserId: string | null;
  ownerUserId: string | null;
}

export interface Skipped {
  list: ListName;
  source: RouteSource;
  reason: string;
}

export interface ResolvedRoute {
  /** There is someone to write to and the point is on. */
  send: boolean;
  /** Why nothing is sent, in words, when `send` is false. */
  reason: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  shown: string[];
  skipped: Skipped[];
}

function find(source: RouteSource, context: ResolveContext): { address: string | null; reason: string } {
  switch (source.kind) {
    case 'staff':
      return { address: context.staffEmails.get(source.userId) ?? null, reason: 'That staff member has no active account.' };
    case 'company':
      return { address: context.companyEmail, reason: 'The company has no email address in Company Setup.' };
    case 'channel':
      return { address: context.channelEmails.get(source.channelId) ?? null, reason: 'That support channel is not an email channel any more.' };
    case 'customer':
      return { address: context.customerEmail, reason: 'The customer gave no email address.' };
    case 'actor':
      return { address: context.actorUserId === null ? null : (context.staffEmails.get(context.actorUserId) ?? null), reason: 'There is no staff member doing this.' };
    case 'owner':
      return { address: context.ownerUserId === null ? null : (context.staffEmails.get(context.ownerUserId) ?? null), reason: 'No staff member made this quote.' };
    case 'address':
      return { address: source.address, reason: '' };
  }
}

/** Finds every list's addresses: valid ones only, each once; To wins over Cc, and Cc over Bcc. */
export function resolveRoute(config: RouteConfig, context: ResolveContext): ResolvedRoute {
  const skipped: Skipped[] = [];
  const resolveList = (name: ListName): string[] => {
    const out: string[] = [];
    for (const source of config[name]) {
      const found = find(source, context);
      const address = found.address?.trim() ?? '';
      if (!isDeliverableAddress(address)) {
        skipped.push({ list: name, source, reason: found.reason === '' ? 'That is not a deliverable address.' : found.reason });
        continue;
      }
      out.push(address);
    }
    return out;
  };
  const once = (addresses: string[], taken: Set<string>): string[] =>
    addresses.filter((address) => {
      const key = address.toLowerCase();
      if (taken.has(key)) return false;
      taken.add(key);
      return true;
    });
  const taken = new Set<string>();
  const to = once(resolveList('to'), taken);
  const cc = once(resolveList('cc'), taken);
  const bcc = once(resolveList('bcc'), taken);
  const replyTo = once(resolveList('replyTo'), new Set<string>());
  const shown = once(resolveList('shown'), new Set<string>());
  const send = config.enabled && to.length > 0;
  const reason = config.enabled ? 'There is nobody to write to.' : 'This email is switched off.';
  return { send, reason: send ? null : reason, to, cc, bcc, replyTo, shown, skipped };
}

/** The addressing of a mail, in the shape the mail port takes; only for a route that is to be sent (`send` is true). */
export function addressing(route: ResolvedRoute): { to: string; toMore?: string[]; cc?: string[]; bcc?: string[]; replyTo?: string[] } {
  const [first = '', ...rest] = route.to;
  return {
    to: first,
    ...(rest.length === 0 ? {} : { toMore: rest }),
    ...(route.cc.length === 0 ? {} : { cc: route.cc }),
    ...(route.bcc.length === 0 ? {} : { bcc: route.bcc }),
    ...(route.replyTo.length === 0 ? {} : { replyTo: route.replyTo }),
  };
}
