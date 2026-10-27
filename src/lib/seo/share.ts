import { has } from '@/lib/values';

/** The widths a shared-link picture is made at: 1200 is the size Facebook, X, LinkedIn and WhatsApp all ask for. */
export const SHARE_IMAGE_WIDTH = 1200;

/**
 * A picture address for a shared link. Chat apps drop big pictures (WhatsApp ignores most above ~600 KB), so the
 * picture goes through the app's own image resizer, which answers a 1200px-wide JPEG. A picture on this same site
 * is passed as a path (the resizer reads it in-process); one kept elsewhere is passed whole. Addresses that cannot be
 * resized (vector images) are returned as they are, made absolute.
 */
export function shareImageUrl(base: string, image: string, width = SHARE_IMAGE_WIDTH): string | null {
  const trimmed = image.trim();
  if (!has(trimmed)) return null;
  const root = base.replace(/\/+$/, '');
  let source = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    if (trimmed.toLowerCase().startsWith(`${root.toLowerCase()}/`)) source = trimmed.slice(root.length);
  } else if (!trimmed.startsWith('/')) {
    source = `/${trimmed}`;
  }
  const absolute = /^https?:\/\//i.test(source) ? source : `${root}${source}`;
  if (/\.svg(\?|#|$)/i.test(source) || source.startsWith('data:')) return absolute;
  return `${root}/_next/image?url=${encodeURIComponent(source)}&w=${String(width)}&q=75`;
}
