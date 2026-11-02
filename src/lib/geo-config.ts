import type { GeoProviderId } from '@/lib/geo-providers';

/** The settings of the OpenStreetMap provider, after checking. Empty server addresses mean the free public servers. */
export interface OsmConfig {
  contactEmail: string;
  countryCodes: string[];
  nominatimUrl: string;
  osrmUrl: string;
  tileUrl: string;
}

export const OSM_DEFAULTS = {
  nominatimUrl: 'https://nominatim.openstreetmap.org',
  osrmUrl: 'https://router.project-osrm.org',
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
} as const;

/** Hosts the public servers run on; they are asked for at most one request a second and their answers are cached. */
export const PUBLIC_OSM_HOSTS: readonly string[] = ['nominatim.openstreetmap.org', 'router.project-osrm.org', 'routing.openstreetmap.de', 'tile.openstreetmap.org'];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BLOCKED_HOST = /^(localhost|metadata\.google\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1?\]?)$/i;

/** A server address that is safe to call from the server: https, a real host, not this machine or a cloud metadata address. */
export function readServerUrl(raw: unknown, what: string, fallback: string, template = false): { ok: true; value: string } | { ok: false; error: string } {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return { ok: true, value: fallback };
  if (text.length > 300) return { ok: false, error: `The ${what} address is too long.` };
  let url: URL;
  try {
    url = new URL(template ? text.replace(/\{[xyz]\}/g, '0') : text);
  } catch {
    return { ok: false, error: `The ${what} address is not a web address.` };
  }
  if (url.protocol !== 'https:') return { ok: false, error: `The ${what} address must start with https://.` };
  if (url.username !== '' || url.password !== '') return { ok: false, error: `The ${what} address must not contain a user name or password.` };
  if (BLOCKED_HOST.test(url.hostname)) return { ok: false, error: `The ${what} address points at this machine or a reserved address, which is not allowed.` };
  if (template && !text.includes('{z}')) return { ok: false, error: 'The map picture address needs {z}, {x} and {y} in it.' };
  return { ok: true, value: template ? text : text.replace(/\/+$/, '') };
}

export function readOsmConfig(raw: Record<string, unknown>): { ok: true; value: OsmConfig } | { ok: false; error: string } {
  const email = typeof raw.contactEmail === 'string' ? raw.contactEmail.trim() : '';
  if (email === '' || !EMAIL.test(email) || email.length > 200) return { ok: false, error: 'Give a contact email. OpenStreetMap’s servers require one so they can reach you if your use causes a problem.' };
  const codesText = typeof raw.countryCodes === 'string' ? raw.countryCodes : '';
  const codes = [...new Set(codesText.split(/[\s,;]+/).map((c) => c.trim().toLowerCase()).filter((c) => c !== ''))];
  if (codes.some((c) => !/^[a-z]{2}$/.test(c)) || codes.length > 10) return { ok: false, error: 'Countries are two-letter codes such as ke, separated by commas.' };
  const nominatim = readServerUrl(raw.nominatimUrl, 'address search server', OSM_DEFAULTS.nominatimUrl);
  if (!nominatim.ok) return nominatim;
  const osrm = readServerUrl(raw.osrmUrl, 'road distance server', OSM_DEFAULTS.osrmUrl);
  if (!osrm.ok) return osrm;
  const tiles = readServerUrl(raw.tileUrl, 'map picture server', OSM_DEFAULTS.tileUrl, true);
  if (!tiles.ok) return tiles;
  return { ok: true, value: { contactEmail: email, countryCodes: codes, nominatimUrl: nominatim.value, osrmUrl: osrm.value, tileUrl: tiles.value } };
}

/** The settings of a provider as the form sends them, checked. A provider that needs none gives an empty object. */
export function readGeoConfig(driver: GeoProviderId, raw: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  if (driver === 'osm') {
    const read = readOsmConfig(input);
    return read.ok ? { ok: true, value: { ...read.value } } : read;
  }
  return { ok: true, value: {} };
}
