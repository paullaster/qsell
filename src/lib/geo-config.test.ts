import { describe, expect, it } from 'vitest';
import { OSM_DEFAULTS, readGeoConfig, readOsmConfig, readServerUrl } from './geo-config';

describe('readServerUrl', () => {
  it('uses the fallback when empty and trims trailing slashes', () => {
    expect(readServerUrl('  ', 'x', 'https://a.test')).toEqual({ ok: true, value: 'https://a.test' });
    expect(readServerUrl('https://geo.example.co.ke//', 'x', 'https://a.test')).toEqual({ ok: true, value: 'https://geo.example.co.ke' });
  });
  it('refuses anything that is not https, or points at this machine or a metadata address', () => {
    for (const bad of ['http://geo.example.com', 'ftp://x.com', 'geo.example.com', 'https://localhost:8080', 'https://127.0.0.1', 'https://169.254.169.254/latest', 'https://metadata.google.internal', 'https://user:pw@geo.example.com', 'https://0.0.0.0', 'https://[::1]/']) {
      expect(readServerUrl(bad, 'search', 'https://a.test').ok, bad).toBe(false);
    }
  });
  it('allows a server on a private network address that is not this machine', () => {
    expect(readServerUrl('https://10.0.0.5:8443', 'x', 'https://a.test').ok).toBe(true);
  });
  it('needs the tile placeholders in a picture address', () => {
    expect(readServerUrl('https://tiles.example.com/{z}/{x}/{y}.png', 'p', OSM_DEFAULTS.tileUrl, true).ok).toBe(true);
    expect(readServerUrl('https://tiles.example.com/map.png', 'p', OSM_DEFAULTS.tileUrl, true)).toMatchObject({ ok: false });
  });
});

describe('readOsmConfig', () => {
  it('needs a contact email and fills the public servers in', () => {
    expect(readOsmConfig({})).toMatchObject({ ok: false });
    expect(readOsmConfig({ contactEmail: 'not-an-email' })).toMatchObject({ ok: false });
    expect(readOsmConfig({ contactEmail: 'maps@shop.co.ke' })).toEqual({ ok: true, value: { contactEmail: 'maps@shop.co.ke', countryCodes: [], nominatimUrl: OSM_DEFAULTS.nominatimUrl, osrmUrl: OSM_DEFAULTS.osrmUrl, tileUrl: OSM_DEFAULTS.tileUrl } });
  });
  it('reads country codes in any separator and refuses nonsense', () => {
    expect(readOsmConfig({ contactEmail: 'a@b.co', countryCodes: 'KE, ug;tz  ke' })).toMatchObject({ ok: true, value: { countryCodes: ['ke', 'ug', 'tz'] } });
    expect(readOsmConfig({ contactEmail: 'a@b.co', countryCodes: 'kenya' })).toMatchObject({ ok: false });
  });
  it('names the field whose address is wrong', () => {
    expect(readOsmConfig({ contactEmail: 'a@b.co', osrmUrl: 'http://x.com' })).toMatchObject({ ok: false, error: expect.stringContaining('road distance server') as string });
  });
});

describe('readGeoConfig', () => {
  it('needs nothing for the built-in estimate and checks OpenStreetMap', () => {
    expect(readGeoConfig('builtin', undefined)).toEqual({ ok: true, value: {} });
    expect(readGeoConfig('osm', { contactEmail: 'a@b.co' })).toMatchObject({ ok: true });
    expect(readGeoConfig('osm', null)).toMatchObject({ ok: false });
  });
});
