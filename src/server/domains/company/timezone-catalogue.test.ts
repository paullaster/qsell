import { describe, expect, it, vi } from 'vitest';
import { TIME_ZONE_LIST_URL, TimeZoneCatalogue } from './timezone-catalogue';

const answer = (body: string, ok = true) => ({ ok, text: () => Promise.resolve(body) });
const MINUTE = 60_000;

function catalogue(respond: () => Promise<{ ok: boolean; text: () => Promise<string> }>) {
  const clock = { now: 1_000_000 };
  const fetcher = vi.fn(respond);
  return { clock, fetcher, catalogue: new TimeZoneCatalogue(fetcher, () => clock.now) };
}

describe('the list of time zones the picker offers', () => {
  it('takes the open list, keeps only zones the system can use, once each and in order, and asks only for that list', async () => {
    const { catalogue: c, fetcher } = catalogue(() => Promise.resolve(answer(JSON.stringify(['Europe/London', 'Africa/Nairobi', 'Africa/Nairobi', 'EST', 'Mars/X', '<b>x</b>', 7]))));
    expect(await c.zones()).toEqual({ zones: ['Africa/Nairobi', 'Europe/London'], source: 'api' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // The one thing asked for: the list, at the one address, with no person, company or order detail.
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, object];
    expect(url).toBe(TIME_ZONE_LIST_URL);
    expect(Object.keys(init).sort()).toEqual(['cache', 'headers', 'signal']);
  });

  it('asks once however many ask at once, and again only after a day', async () => {
    const { catalogue: c, fetcher, clock } = catalogue(() => Promise.resolve(answer(JSON.stringify(['Africa/Nairobi']))));
    await Promise.all([c.zones(), c.zones(), c.zones(), c.zones(), c.zones()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    clock.now += 23 * 60 * MINUTE;
    await c.zones();
    expect(fetcher).toHaveBeenCalledTimes(1);
    clock.now += 2 * 60 * MINUTE;
    await c.zones();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['cannot be reached', () => Promise.reject(new Error('ECONNREFUSED'))],
    ['answers with an error', () => Promise.resolve(answer('Bad gateway', false))],
    ['answers with something that is not JSON', () => Promise.resolve(answer('<html>hello</html>'))],
    ['answers with something that is not a list', () => Promise.resolve(answer(JSON.stringify({ zones: ['Africa/Nairobi'] })))],
    ['answers with a list with no usable zone', () => Promise.resolve(answer(JSON.stringify(['EST', 'nonsense'])))],
    ['answers with far too much', () => Promise.resolve(answer(JSON.stringify(Array.from({ length: 30_000 }, (_, i) => `Africa/City_${String(i)}`))))],
  ])('offers the zones the system itself knows when the open list %s', async (_what, respond) => {
    const { catalogue: c } = catalogue(respond);
    const list = await c.zones();
    expect(list.source).toBe('runtime');
    expect(list.zones).toContain('Africa/Nairobi');
    expect(list.zones).toContain('UTC');
    expect(list.zones.length).toBeGreaterThan(100);
  });

  it('tries the open list again after five minutes when it could not be had, and keeps an older answer rather than falling back', async () => {
    let up = false;
    const { catalogue: c, fetcher, clock } = catalogue(() => (up ? Promise.resolve(answer(JSON.stringify(['Africa/Nairobi', 'Asia/Tokyo']))) : Promise.reject(new Error('down'))));
    expect((await c.zones()).source).toBe('runtime');
    clock.now += 4 * MINUTE;
    await c.zones();
    expect(fetcher).toHaveBeenCalledTimes(1);
    up = true;
    clock.now += 2 * MINUTE;
    expect(await c.zones()).toEqual({ zones: ['Africa/Nairobi', 'Asia/Tokyo'], source: 'api' });
    // A day later the service is down again: the list had before is kept, and it is asked for again in five minutes.
    up = false;
    clock.now += 25 * 60 * MINUTE;
    expect(await c.zones()).toEqual({ zones: ['Africa/Nairobi', 'Asia/Tokyo'], source: 'api' });
    const calls = fetcher.mock.calls.length;
    clock.now += 2 * MINUTE;
    await c.zones();
    expect(fetcher.mock.calls.length).toBe(calls);
    clock.now += 4 * MINUTE;
    await c.zones();
    expect(fetcher.mock.calls.length).toBe(calls + 1);
  });
});
