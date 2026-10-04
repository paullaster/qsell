/**
 * Upload validation that trusts nothing from the client: the file type comes
 * from the file's own signature, not its declared MIME type or name.
 *
 * SVG is deliberately not accepted — it is XML that can carry script.
 */

import { DEFAULT_MAX_IMAGE_BYTES } from '@/lib/media';

export interface SniffedImage {
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'image/avif';
  width?: number;
  height?: number;
}

export { DEFAULT_MAX_IMAGE_BYTES };

export function maxImageBytes(): number {
  const configured = Number(process.env.MEDIA_MAX_IMAGE_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_IMAGE_BYTES;
}

function ascii(buffer: Buffer, start: number, end: number): string {
  return buffer.toString('latin1', start, end);
}

function jpegSize(buffer: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    // SOF0–SOF15, except DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpSize(buffer: Buffer): { width: number; height: number } | undefined {
  const chunk = ascii(buffer, 12, 16);
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
  }
  if (chunk === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ' && buffer.length >= 30) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  return undefined;
}

/** The image type (and dimensions where cheap to read) from the file's signature, or null. */
export function sniffImage(buffer: Buffer): SniffedImage | null {
  if (buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', ...jpegSize(buffer) };
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return buffer.length >= 24
      ? { mime: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
      : { mime: 'image/png' };
  }
  const gifHeader = ascii(buffer, 0, 6);
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return { mime: 'image/gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ...webpSize(buffer) };
  }
  if (ascii(buffer, 4, 8) === 'ftyp') {
    const brand = ascii(buffer, 8, 12);
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif' };
  }
  return null;
}

/**
 * Accepts http(s) links and root-relative paths (same rule as the CSV import):
 * no `javascript:`, `data:` or protocol-relative values. Returns the trimmed
 * original, not a normalised form, so it matches what is already stored.
 */
export function parseExternalUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 2048) return null;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:' ? trimmed : null;
  } catch {
    return null;
  }
}
