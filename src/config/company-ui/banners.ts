import { BANNER_LIMITS, BANNER_MOTIONS, BANNER_SIZES, BANNER_SPEEDS, type PromoBanner } from './types';
import { firstFilled, orElse } from '@/lib/values';
import { bannerColor, textColorFor } from './banner-colors';

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day as `YYYY-MM-DD`, or empty. */
function day(value: unknown): string {
  const raw = text(value, 10);
  if (!DAY.test(raw)) return '';
  const parsed = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw ? '' : raw;
}

/** A page of the shop or an http(s) address. Anything else (javascript:, data:, //host) is dropped so it can never reach an href. */
export function safeBannerHref(value: unknown): string {
  const raw = text(value, BANNER_LIMITS.href);
  if (raw === '') return '';
  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\')) return raw;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

/** A picture of this site (a path) or at an https address; nothing else can reach an img src. */
export function safeBannerImage(value: unknown): string {
  const raw = text(value, BANNER_LIMITS.image);
  if (raw === '') return '';
  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\')) return raw;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((item) => item === value) ?? fallback;
}

/** Normalises stored or submitted banners. A banner with no title is dropped; a closing day before the opening day is dropped. Never throws. */
export function resolveBanners(raw: unknown): PromoBanner[] {
  if (!Array.isArray(raw)) return [];
  const out: PromoBanner[] = [];
  for (const [index, item] of raw.entries()) {
    if (!isPlainObject(item)) continue;
    const title = text(item.title, BANNER_LIMITS.title);
    if (title === '') continue;
    const startsOn = day(item.startsOn);
    let endsOn = day(item.endsOn);
    if (startsOn !== '' && endsOn !== '' && endsOn < startsOn) endsOn = '';
    const href = safeBannerHref(item.href);
    const background = bannerColor(item.background);
    const chosenText = bannerColor(item.textColor);
    out.push({
      id: orElse(text(item.id, 64), `banner-${String(index)}`),
      title,
      text: text(item.text, BANNER_LIMITS.text),
      href,
      cta: href === '' ? '' : orElse(firstFilled(text(item.cta, BANNER_LIMITS.cta)), 'Shop now'),
      startsOn,
      endsOn,
      active: item.active !== false,
      background,
      // Text that cannot be read on the background is replaced by text that can, so nothing unreadable is ever stored.
      textColor: background === '' || chosenText === '' ? '' : textColorFor(background, chosenText),
      imageUrl: safeBannerImage(item.imageUrl),
      motion: oneOf(item.motion, BANNER_MOTIONS, 'still'),
      speed: oneOf(item.speed, BANNER_SPEEDS, 'normal'),
      size: oneOf(item.size, BANNER_SIZES, 'normal'),
    });
    if (out.length >= BANNER_LIMITS.banners) break;
  }
  return out;
}

/** The banners to show on `today` (`YYYY-MM-DD`, passed in so this stays pure): switched on and inside their days. */
export function activeBanners(banners: readonly PromoBanner[], today: string): PromoBanner[] {
  return banners.filter((banner) => banner.active && (banner.startsOn === '' || banner.startsOn <= today) && (banner.endsOn === '' || today <= banner.endsOn));
}
