import { runtimeZones, zonesFromList } from '@/lib/business-timezone';

/**
 * The open list of time zones the Business time zone picker offers. WorldTimeAPI publishes the IANA zones as a plain list; it is asked
 * for that list (and nothing else: no company, person or order detail is sent), and every name in the answer is checked against the
 * runtime before it is offered. When the service cannot be reached, is slow, or answers with something that is not a list of zones,
 * the picker offers the zones the system itself knows, so choosing a zone never waits on, or breaks with, an outside service.
 */
export const TIME_ZONE_LIST_URL = 'https://worldtimeapi.org/api/timezone';

export type ZoneSource = 'api' | 'runtime';
export interface ZoneList {
  zones: string[];
  source: ZoneSource;
}

/** An answer larger than this is not a list of zones. */
const MAX_BYTES = 200_000;
/** The outside list is asked for again after a day; when it could not be had, after five minutes. */
const API_TTL_MS = 24 * 60 * 60 * 1000;
const FALLBACK_TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 4_000;

type Fetch = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string>; cache?: 'no-store' }) => Promise<{ ok: boolean; text: () => Promise<string> }>;

export class TimeZoneCatalogue {
  private held: (ZoneList & { at: number }) | null = null;
  private inflight: Promise<ZoneList> | null = null;

  constructor(
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
    private readonly clock: () => number = () => Date.now(),
    private readonly url: string = TIME_ZONE_LIST_URL,
  ) {}

  /** The zones on offer, from the open list when it can be had and from the runtime when not. Never throws, never waits more than a few seconds, asks once however many ask at once. */
  async zones(): Promise<ZoneList> {
    const held = this.held;
    if (held !== null && this.clock() - held.at < (held.source === 'api' ? API_TTL_MS : FALLBACK_TTL_MS)) return { zones: held.zones, source: held.source };
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return await this.inflight;
  }

  private async load(): Promise<ZoneList> {
    const fetched = await this.fromApi();
    if (fetched !== null) {
      this.held = { zones: fetched, source: 'api', at: this.clock() };
    } else {
      // A list that was had before and has not been replaced is better than the runtime's; it is asked for again in five minutes.
      const before = this.held;
      this.held = before?.source === 'api' ? { ...before, at: this.clock() - API_TTL_MS + FALLBACK_TTL_MS } : { zones: runtimeZones(), source: 'runtime', at: this.clock() };
    }
    return { zones: this.held.zones, source: this.held.source };
  }

  private async fromApi(): Promise<string[] | null> {
    try {
      const answer = await this.fetcher(this.url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!answer.ok) return null;
      const text = await answer.text();
      if (text.length > MAX_BYTES) return null;
      return zonesFromList(JSON.parse(text) as unknown);
    } catch {
      return null;
    }
  }
}

/** The one catalogue the picker reads (one list, one daily request, however many people open the screen). */
export const timeZoneCatalogue = new TimeZoneCatalogue();
