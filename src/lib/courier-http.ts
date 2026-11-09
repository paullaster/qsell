import { COURIER_STATES, type CourierState } from '@/lib/courier-states';

/**
 * The rules for a courier whose system speaks JSON over https: how its address and settings are checked, where in its answers the
 * tracking number and the news are found, and which of its words mean which state. Pure; the calls themselves are the adapter's.
 * Our side of the conversation is fixed and documented (the reference, the recipient, the place, the parcels); only the courier's answers are mapped.
 */
export interface CourierMapping {
  /** Where in each answer the thing is found, as a dotted path ("data.tracking_number", "events.0.status"). */
  tracking: string;
  trackingUrl: string;
  label: string;
  status: string;
  note: string;
  receivedBy: string;
  proof: string;
  /** The courier's id for one piece of news, so the same one sent twice counts once. */
  eventId: string;
  at: string;
  /** Which of the courier's words mean which of our states (compared without regard to case). */
  states: Record<CourierState, string[]>;
}

export const DEFAULT_MAPPING: CourierMapping = {
  tracking: 'tracking_number',
  trackingUrl: 'tracking_url',
  label: 'label_url',
  status: 'status',
  note: 'note',
  receivedBy: 'received_by',
  proof: 'proof_url',
  eventId: 'event_id',
  at: 'at',
  states: { booked: ['booked', 'created', 'pending'], in_transit: ['in_transit', 'picked_up', 'out_for_delivery', 'shipped'], delivered: ['delivered', 'completed'], exception: ['failed', 'exception', 'undelivered', 'returned', 'cancelled'] },
};

export interface HttpCourierSettings {
  baseUrl: string;
  /** The header that carries the key, "Authorization" unless the courier says otherwise. The key itself is a secret kept apart. */
  authHeader: string;
  bookPath: string;
  trackPath: string;
  cancelPath: string;
  cancelMethod: 'DELETE' | 'POST';
  mapping: CourierMapping;
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

/** Whether a literal address (not a name) is one that is not on the public internet. */
export function privateAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h.includes(':')) return h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('::ffff:');
  return PRIVATE_V4.some((r) => r.test(h));
}

/** Why a courier's address cannot be used, or null. Only https, only a public name or address, no passwords in it, no port but the usual one. */
export function addressProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'The courier\'s address is not a web address.';
  }
  if (u.protocol !== 'https:') return 'The courier\'s address must start with https://.';
  if (u.username !== '' || u.password !== '') return 'Do not put a name or password in the address; the key goes in its own box.';
  if (u.port !== '' && u.port !== '443') return 'Use the courier\'s usual https address, without a port.';
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !host.includes(':')) return 'That address is not on the public internet.';
  if (privateAddress(host)) return 'That address is not on the public internet.';
  return null;
}

const PATH = /^\/[A-Za-z0-9._~\-/{}]*$/;
const DOTTED = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const HEADER = /^[A-Za-z][A-Za-z0-9-]{0,40}$/;

const MAP_KEYS = ['tracking', 'trackingUrl', 'label', 'status', 'note', 'receivedBy', 'proof', 'eventId', 'at'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The mapping typed (as JSON text or an object), checked, with the defaults for whatever was left out. */
export function checkMapping(raw: unknown): { ok: true; mapping: CourierMapping } | { ok: false; error: string } {
  let given: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return { ok: true, mapping: DEFAULT_MAPPING };
    if (raw.length > 4000) return { ok: false, error: 'The answer mapping is too long.' };
    try {
      given = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'The answer mapping is not valid JSON.' };
    }
  }
  if (given === undefined || given === null) return { ok: true, mapping: DEFAULT_MAPPING };
  if (!isRecord(given)) return { ok: false, error: 'The answer mapping must be a JSON object.' };
  const mapping: CourierMapping = { ...DEFAULT_MAPPING, states: { ...DEFAULT_MAPPING.states } };
  for (const key of MAP_KEYS) {
    const v = given[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !DOTTED.test(v) || v.length > 80) return { ok: false, error: `"${key}" must be a dotted path such as data.tracking_number.` };
    mapping[key] = v;
  }
  if (given.states !== undefined) {
    if (!isRecord(given.states)) return { ok: false, error: '"states" must say which of the courier\'s words mean which state.' };
    for (const state of COURIER_STATES) {
      const words = given.states[state];
      if (words === undefined) continue;
      if (!Array.isArray(words) || words.length === 0 || words.length > 20 || words.some((w) => typeof w !== 'string' || w.trim() === '' || w.length > 60)) return { ok: false, error: `The words for "${state}" must be a short list of words.` };
      mapping.states[state] = words.map((w) => String(w).trim());
    }
    const seen = new Map<string, CourierState>();
    for (const state of COURIER_STATES) {
      for (const w of mapping.states[state]) {
        const k = w.toLowerCase();
        const other = seen.get(k);
        if (other !== undefined && other !== state) return { ok: false, error: `"${w}" cannot mean both "${other}" and "${state}".` };
        seen.set(k, state);
      }
    }
  }
  return { ok: true, mapping };
}

/** A courier's settings as typed, checked. The key is not part of this: it is sealed apart and never read back. */
export function checkHttpSettings(raw: { baseUrl?: unknown; authHeader?: unknown; bookPath?: unknown; trackPath?: unknown; cancelPath?: unknown; cancelMethod?: unknown; mapping?: unknown }): { ok: true; settings: HttpCourierSettings } | { ok: false; error: string } {
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : '';
  if (baseUrl === '' || baseUrl.length > 300) return { ok: false, error: 'Give the courier\'s web address.' };
  const bad = addressProblem(baseUrl);
  if (bad !== null) return { ok: false, error: bad };
  const header = typeof raw.authHeader === 'string' && raw.authHeader.trim() !== '' ? raw.authHeader.trim() : 'Authorization';
  if (!HEADER.test(header)) return { ok: false, error: 'The header for the key is not a header name.' };
  const path = (v: unknown, fallback: string, what: string, needs: string | null): { ok: true; value: string } | { ok: false; error: string } => {
    const p = typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
    if (!PATH.test(p) || p.length > 120 || p.includes('//') || p.includes('..')) return { ok: false, error: `The ${what} path must start with / and use only letters, numbers and - . _ ~ /.` };
    if (needs !== null && !p.includes(needs)) return { ok: false, error: `The ${what} path must contain ${needs}, where the tracking number goes.` };
    return { ok: true, value: p };
  };
  const book = path(raw.bookPath, '/shipments', 'booking', null);
  if (!book.ok) return book;
  const track = path(raw.trackPath, '/shipments/{tracking}', 'tracking', '{tracking}');
  if (!track.ok) return track;
  const cancel = path(raw.cancelPath, '/shipments/{tracking}', 'cancelling', '{tracking}');
  if (!cancel.ok) return cancel;
  const method = raw.cancelMethod === 'POST' ? 'POST' : 'DELETE';
  const mapped = checkMapping(raw.mapping);
  if (!mapped.ok) return mapped;
  return { ok: true, settings: { baseUrl, authHeader: header, bookPath: book.value, trackPath: track.value, cancelPath: cancel.value, cancelMethod: method, mapping: mapped.mapping } };
}

/** The address of a call: the base, the path, and the tracking number put in (encoded, so nothing can change the path). */
export function callUrl(baseUrl: string, path: string, tracking?: string): string {
  return `${baseUrl}${tracking === undefined ? path : path.replace('{tracking}', encodeURIComponent(tracking))}`;
}

/** What is at a dotted path in an answer, or undefined. A number in the path is a place in a list. */
export function pathGet(value: unknown, path: string): unknown {
  let at: unknown = value;
  for (const part of path.split('.')) {
    if (Array.isArray(at)) {
      const i = Number(part);
      at = Number.isInteger(i) ? at[i] : undefined;
    } else if (isRecord(at)) {
      at = Object.prototype.hasOwnProperty.call(at, part) ? at[part] : undefined;
    } else {
      return undefined;
    }
  }
  return at;
}

/** Text at a path (numbers are written out), trimmed and cut to a length; null when there is none. */
export function textAt(value: unknown, path: string, max = 300): string | null {
  const v = pathGet(value, path);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v).slice(0, max);
  return typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null;
}

/** An https address at a path (a label or a proof), or null: a courier cannot make us link to anything else. */
export function linkAt(value: unknown, path: string): string | null {
  const v = textAt(value, path, 500);
  if (v === null) return null;
  try {
    return new URL(v).protocol === 'https:' ? v : null;
  } catch {
    return null;
  }
}

/** Which of our states a courier's word means, or null when it is a word we were not told about. */
export function stateFor(word: string | null, mapping: CourierMapping): CourierState | null {
  if (word === null) return null;
  const w = word.trim().toLowerCase();
  return COURIER_STATES.find((s) => mapping.states[s].some((x) => x.toLowerCase() === w)) ?? null;
}

/** After how long a parcel with a courier is asked about again: soon at first, then every half hour, and rarely for a parcel that has gone quiet. */
export function nextPollMinutes(minutesSinceUpdate: number): number {
  if (minutesSinceUpdate < 120) return 15;
  if (minutesSinceUpdate < 24 * 60) return 30;
  return 180;
}

/** The wait before another try at booking: 2 minutes, then 4, 8, 16, 32. */
export const bookingWaitMinutes = (tries: number): number => 2 * 2 ** Math.max(0, tries - 1);
export const MAX_BOOKING_TRIES = 6;
