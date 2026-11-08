import { describe, expect, it } from 'vitest';
import { DEFAULT_MAPPING, addressProblem, bookingWaitMinutes, callUrl, checkHttpSettings, checkMapping, linkAt, nextPollMinutes, pathGet, privateAddress, stateFor, textAt } from './courier-http';

describe('a courier\'s address', () => {
  it('takes a public https address and refuses everything else', () => {
    expect(addressProblem('https://api.swiftcouriers.co.ke')).toBeNull();
    for (const bad of ['http://api.swift.co.ke', 'https://localhost', 'https://127.0.0.1', 'https://10.1.2.3', 'https://192.168.0.5', 'https://172.20.1.1', 'https://169.254.169.254', 'https://[::1]', 'https://intranet', 'https://db.internal', 'https://printer.local', 'https://user:pw@api.swift.co.ke', 'https://api.swift.co.ke:8443', 'ftp://x.co.ke', 'not a url']) {
      expect(addressProblem(bad), bad).not.toBeNull();
    }
  });
  it('knows which literal addresses are not public', () => {
    expect(['10.0.0.1', '127.0.0.1', '100.64.0.1', '::1', 'fe80::1', 'fd00::1'].every(privateAddress)).toBe(true);
    expect(['8.8.8.8', '41.90.1.1', '172.32.0.1'].some(privateAddress)).toBe(false);
  });
});

describe('a courier\'s settings', () => {
  it('fills in the usual paths and the usual words', () => {
    const r = checkHttpSettings({ baseUrl: ' https://api.swift.co.ke/ ' });
    expect(r).toMatchObject({ ok: true, settings: { baseUrl: 'https://api.swift.co.ke', authHeader: 'Authorization', bookPath: '/shipments', trackPath: '/shipments/{tracking}', cancelMethod: 'DELETE' } });
    expect(r.ok && r.settings.mapping).toEqual(DEFAULT_MAPPING);
  });
  it('refuses a path with no place for the tracking number, odd characters, a bad header, or no address', () => {
    expect(checkHttpSettings({ baseUrl: 'https://a.co.ke', trackPath: '/shipments' })).toMatchObject({ ok: false, error: expect.stringContaining('{tracking}') as string });
    expect(checkHttpSettings({ baseUrl: 'https://a.co.ke', cancelPath: '/x/{tracking}?a=b' })).toMatchObject({ ok: false });
    expect(checkHttpSettings({ baseUrl: 'https://a.co.ke', bookPath: '/../admin' })).toMatchObject({ ok: false });
    expect(checkHttpSettings({ baseUrl: 'https://a.co.ke', authHeader: 'X Key\r\nEvil: 1' })).toMatchObject({ ok: false });
    expect(checkHttpSettings({ baseUrl: '' })).toMatchObject({ ok: false });
    expect(checkHttpSettings({ baseUrl: 'https://a.co.ke', cancelMethod: 'POST' })).toMatchObject({ ok: true, settings: { cancelMethod: 'POST' } });
  });
});

describe('the mapping of a courier\'s answers', () => {
  it('takes JSON text or an object, keeps the defaults for what is left out and checks what is given', () => {
    expect(checkMapping('')).toMatchObject({ ok: true });
    const m = checkMapping('{"tracking":"data.waybill","states":{"delivered":["DONE"]}}');
    expect(m.ok && m.mapping.tracking).toBe('data.waybill');
    expect(m.ok && m.mapping.status).toBe('status');
    expect(m.ok && m.mapping.states.delivered).toEqual(['DONE']);
    expect(m.ok && m.mapping.states.exception).toEqual(DEFAULT_MAPPING.states.exception);
    for (const bad of ['{', '[]', '{"tracking":"a b"}', '{"tracking":5}', '{"states":{"delivered":[]}}', '{"states":{"delivered":["x"],"exception":["X"]}}', '{"states":7}']) {
      expect(checkMapping(bad), bad).toMatchObject({ ok: false });
    }
  });
  it('finds values by dotted path, through lists, and nothing that is not there', () => {
    const answer = { data: { waybill: 'W1', events: [{ status: 'Delivered' }], n: 42 } };
    expect(pathGet(answer, 'data.events.0.status')).toBe('Delivered');
    expect(textAt(answer, 'data.waybill')).toBe('W1');
    expect(textAt(answer, 'data.n')).toBe('42');
    expect(textAt(answer, 'data.nope')).toBeNull();
    expect(textAt(answer, 'data.events.5.status')).toBeNull();
    expect(pathGet(answer, 'data.__proto__')).toBeUndefined();
    expect(pathGet('text', 'a')).toBeUndefined();
  });
  it('turns the courier\'s word into our state, whatever its case, and ignores a word it was not told', () => {
    expect(stateFor('OUT_FOR_DELIVERY', DEFAULT_MAPPING)).toBe('in_transit');
    expect(stateFor(' Delivered ', DEFAULT_MAPPING)).toBe('delivered');
    expect(stateFor('on the moon', DEFAULT_MAPPING)).toBeNull();
    expect(stateFor(null, DEFAULT_MAPPING)).toBeNull();
  });
  it('links only to https addresses', () => {
    expect(linkAt({ l: 'https://x.co.ke/label.pdf' }, 'l')).toBe('https://x.co.ke/label.pdf');
    expect(linkAt({ l: 'http://x.co.ke/label.pdf' }, 'l')).toBeNull();
    expect(linkAt({ l: 'javascript:alert(1)' }, 'l')).toBeNull();
    expect(linkAt({}, 'l')).toBeNull();
  });
});

describe('calls and waits', () => {
  it('puts the tracking number into the path encoded, so it cannot change where the call goes', () => {
    expect(callUrl('https://a.co.ke', '/shipments/{tracking}', 'W 1/../x')).toBe('https://a.co.ke/shipments/W%201%2F..%2Fx');
    expect(callUrl('https://a.co.ke', '/shipments')).toBe('https://a.co.ke/shipments');
  });
  it('asks again sooner for a fresh parcel than for one that has gone quiet, and waits longer after each failed booking', () => {
    expect([nextPollMinutes(10), nextPollMinutes(300), nextPollMinutes(3000)]).toEqual([15, 30, 180]);
    expect([1, 2, 3, 4, 5].map(bookingWaitMinutes)).toEqual([2, 4, 8, 16, 32]);
  });
});
