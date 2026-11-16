import type { GeoPoint } from '@/lib/geo';

const ROUND = 1e6;

const inRange = (latitude: number, longitude: number): boolean => Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;

/**
 * A place as a customer shares it: the two numbers ("-1.2921, 36.8219", as WhatsApp or a phone's map copies them) or a link from a map
 * app that carries them (Google Maps `@lat,lng`, `q=lat,lng`, `!3dlat!4dlng`, OpenStreetMap `mlat=..&mlon=..`). Not a short link, which
 * hides the place behind an address that cannot be opened from here; that is said in words.
 */
export function readPinText(text: string): { ok: true; point: GeoPoint } | { ok: false; error: string } {
  const raw = text.trim();
  if (raw === '') return { ok: false, error: 'Paste the place the customer shared: two numbers like -1.2921, 36.8219, or a link from a map app.' };
  const number = '(-?\\d{1,3}(?:\\.\\d+)?)';
  const patterns = [
    new RegExp(`^${number}\\s*[,;\\s]\\s*${number}$`),
    new RegExp(`@${number},${number}`),
    new RegExp(`[?&](?:q|ll|query|destination)=${number}(?:,|%2C)${number}`),
    new RegExp(`!3d${number}!4d${number}`),
    new RegExp(`mlat=${number}.*?mlon=${number}`),
  ];
  for (const pattern of patterns) {
    const found = pattern.exec(raw);
    if (found === null) continue;
    const latitude = Number(found[1]);
    const longitude = Number(found[2]);
    if (!inRange(latitude, longitude)) return { ok: false, error: 'Those numbers are not a place on the earth. The first is the latitude (up to 90) and the second the longitude (up to 180).' };
    return { ok: true, point: { latitude: Math.round(latitude * ROUND) / ROUND, longitude: Math.round(longitude * ROUND) / ROUND } };
  }
  if (/^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|bit\.ly|tinyurl\.com)/i.test(raw)) {
    return { ok: false, error: 'That is a short link, which hides the place. Open it in a browser and copy the long address, or ask the customer for the two numbers.' };
  }
  return { ok: false, error: 'We could not find a place in that. Paste two numbers like -1.2921, 36.8219, or the long link from a map app.' };
}

/** A pin written the way it is pasted back: "latitude, longitude". */
export const pinText = (point: GeoPoint): string => `${String(point.latitude)}, ${String(point.longitude)}`;
