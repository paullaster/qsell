import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { callUrl, linkAt, privateAddress, stateFor, textAt, type HttpCourierSettings } from '@/lib/courier-http';
import { CourierError, type CourierBooking, type CourierNews, type CourierPort, type CourierPush, type CourierShipmentRequest } from './port';

const TIMEOUT_MS = 10_000;
const MAX_BODY = 200_000;

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect: 'error' }) => Promise<{ status: number; text(): Promise<string> }>;
export type Resolver = (host: string) => Promise<string[]>;

const defaultResolve: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/** Whether a signature the courier sent is the one made from the body with the shared secret (compared without leaking where it differs). */
export function signatureValid(secret: string, body: string, header: string | null): boolean {
  if (header === null) return false;
  const given = header.trim().replace(/^sha256=/i, '').toLowerCase();
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A courier that speaks JSON over https. We send a fixed, documented request and find the courier's answer by the paths and words set for it, so a
 * courier's system is connected by settings and not by code. A call has a time limit, follows no redirect, goes only to a public address, and reads
 * a bounded answer; whatever goes wrong becomes a CourierError in plain words, never the courier's own text or our key.
 */
export class HttpJsonCourierAdapter implements CourierPort {
  readonly id = 'http_json';

  constructor(
    private readonly settings: HttpCourierSettings,
    private readonly key: string,
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
    private readonly resolve: Resolver = defaultResolve,
  ) {}

  private async call(method: string, path: string, tracking?: string, body?: unknown): Promise<unknown> {
    const url = callUrl(this.settings.baseUrl, path, tracking);
    const host = new URL(url).hostname;
    // A name that points inside our network is refused here, at the time of the call, not only when the address was typed.
    let addresses: string[];
    try {
      addresses = await this.resolve(host);
    } catch {
      throw new CourierError('The courier\'s address could not be found.', true);
    }
    if (addresses.length === 0 || addresses.some(privateAddress)) throw new CourierError('The courier\'s address is not on the public internet.', false);
    let res: { status: number; text(): Promise<string> };
    try {
      res = await this.fetcher(url, {
        method,
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), [this.settings.authHeader]: this.key },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch {
      throw new CourierError('The courier could not be reached.', true);
    }
    if (res.status === 404 && method !== 'GET') return null;
    if (res.status === 429 || res.status >= 500) throw new CourierError(`The courier is not answering properly just now (${String(res.status)}).`, true);
    if (res.status >= 400) throw new CourierError(`The courier refused the request (${String(res.status)}).`, false);
    let text: string;
    try {
      text = (await res.text()).slice(0, MAX_BODY);
    } catch {
      throw new CourierError('The courier\'s answer could not be read.', true);
    }
    if (text.trim() === '') return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CourierError('The courier\'s answer was not JSON.', false);
    }
  }

  async book(request: CourierShipmentRequest): Promise<CourierBooking> {
    const answer = await this.call('POST', this.settings.bookPath, undefined, {
      reference: request.deliveryNumber,
      recipient: { name: request.recipientName, phone: request.recipientPhone },
      destination: request.destination,
      parcels: request.parcels,
    });
    const m = this.settings.mapping;
    const tracking = textAt(answer, m.tracking, 120);
    if (tracking === null) throw new CourierError('The courier booked the parcel but sent no tracking number.', false);
    return { trackingNumber: tracking, trackingUrl: linkAt(answer, m.trackingUrl), labelUrl: linkAt(answer, m.label), externalId: tracking };
  }

  async track(trackingNumber: string): Promise<CourierNews | null> {
    const answer = await this.call('GET', this.settings.trackPath, trackingNumber);
    return answer === null ? null : this.newsOf(answer);
  }

  async cancel(trackingNumber: string): Promise<void> {
    await this.call(this.settings.cancelMethod, this.settings.cancelPath, trackingNumber);
  }

  parseWebhook(body: string): CourierPush | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.slice(0, MAX_BODY));
    } catch {
      return null;
    }
    const m = this.settings.mapping;
    const tracking = textAt(parsed, m.tracking, 120);
    const news = this.newsOf(parsed);
    if (tracking === null || news === null) return null;
    return { trackingNumber: tracking, eventId: textAt(parsed, m.eventId, 120) ?? createHash('sha256').update(body).digest('hex').slice(0, 40), news };
  }

  /** The news in an answer: null when the courier's word for the state is not one we were told about. */
  private newsOf(answer: unknown): CourierNews | null {
    const m = this.settings.mapping;
    const state = stateFor(textAt(answer, m.status, 60), m);
    if (state === null) return null;
    const atText = textAt(answer, m.at, 40);
    const at = atText === null ? null : new Date(atText);
    return { state, note: textAt(answer, m.note, 300), at: at !== null && !Number.isNaN(at.getTime()) ? at : null, receivedBy: textAt(answer, m.receivedBy, 120), proofUrl: linkAt(answer, m.proof), trackingNumber: textAt(answer, m.tracking, 120) };
  }
}
