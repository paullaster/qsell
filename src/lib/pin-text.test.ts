import { describe, expect, it } from 'vitest';
import { pinText, readPinText } from './pin-text';

describe('a place as a customer shares it', () => {
  it('reads two numbers however they are separated, and rounds them to six places', () => {
    expect(readPinText('-1.2921, 36.8219')).toEqual({ ok: true, point: { latitude: -1.2921, longitude: 36.8219 } });
    expect(readPinText('  -1.2921 36.8219 ')).toEqual({ ok: true, point: { latitude: -1.2921, longitude: 36.8219 } });
    expect(readPinText('-1.29210049;36.82190049')).toEqual({ ok: true, point: { latitude: -1.2921, longitude: 36.8219 } });
    expect(readPinText('1,36')).toEqual({ ok: true, point: { latitude: 1, longitude: 36 } });
  });
  it('reads the place out of the links a map app gives', () => {
    const want = { ok: true, point: { latitude: -1.286389, longitude: 36.817223 } };
    expect(readPinText('https://www.google.com/maps/place/Nairobi/@-1.286389,36.817223,15z/data=!4m5')).toEqual(want);
    expect(readPinText('https://maps.google.com/?q=-1.286389,36.817223')).toEqual(want);
    expect(readPinText('https://www.google.com/maps/dir/?api=1&destination=-1.286389%2C36.817223')).toEqual(want);
    expect(readPinText('https://www.google.com/maps/place/x/data=!3d-1.286389!4d36.817223')).toEqual(want);
    expect(readPinText('https://www.openstreetmap.org/?mlat=-1.286389&mlon=36.817223#map=16/-1.28/36.81')).toEqual(want);
  });
  it('says in words what is wrong: nothing, off the earth, a short link, or no place at all', () => {
    expect(readPinText('   ')).toMatchObject({ ok: false, error: expect.stringContaining('Paste the place') as string });
    expect(readPinText('95.1, 36.8')).toMatchObject({ ok: false, error: expect.stringContaining('not a place on the earth') as string });
    expect(readPinText('-1.2, 200.5')).toMatchObject({ ok: false, error: expect.stringContaining('not a place on the earth') as string });
    expect(readPinText('https://maps.app.goo.gl/AbCdEf123')).toMatchObject({ ok: false, error: expect.stringContaining('short link') as string });
    expect(readPinText('near the big baobab')).toMatchObject({ ok: false, error: expect.stringContaining('could not find a place') as string });
  });
  it('writes a place back as it is pasted', () => {
    expect(pinText({ latitude: -1.2921, longitude: 36.8219 })).toBe('-1.2921, 36.8219');
    expect(readPinText(pinText({ latitude: -1.2921, longitude: 36.8219 }))).toEqual({ ok: true, point: { latitude: -1.2921, longitude: 36.8219 } });
  });
});
